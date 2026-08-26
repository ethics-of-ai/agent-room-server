import { JsonRpcMethodNotFoundError } from "../shared/JsonRpcLineClient";
import {
  CURSOR_QUESTION_INPUT_SCHEMA,
  CURSOR_QUESTION_TOOL_DESCRIPTION,
  CURSOR_QUESTION_TOOL_NAME
} from "./questions";
import {
  agentSendParamsSchema,
  agentStartParamsSchema,
  cursorHostIncomingFrameSchema,
  initializeParamsSchema,
  questionAskResultSchema,
  runCancelParamsSchema,
  type CursorHostIncomingFrame
} from "./protocol";
import {
  boundedCursorShellDelta,
  MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN
} from "./delta";
import type { CursorRun, CursorSdk, CursorSdkAgent } from "./sdk";
import { loadCursorSdk } from "./sdk";

/**
 * The Cursor SDK host: the one process that imports `@cursor/sdk`
 * (docs/engineering/CURSOR_SDK_RUNNER.md). The backend spawns one per AgentRoom
 * session with a scrubbed environment and drives it over newline-delimited
 * JSON-RPC on stdio. This module holds one `SDKAgent`, serves the backend's
 * requests, forwards the run stream, and relays the clarifying-question custom
 * tool's callback back to the backend as one `question/ask` request.
 *
 * `CursorHost` is transport-agnostic and injectable so `cursorHost.test.ts` can
 * drive it against a fake SDK and a fake transport; the stdio wiring and the
 * real SDK loader live in {@link runCursorHostStdio} at the bottom.
 */

export interface CursorHostTransport {
  /** Emit a host → backend notification (no id). */
  notify(method: string, params: unknown): void;
  /** Make the one host → backend request (`question/ask`) and await its answer. */
  request(method: string, params: unknown): Promise<unknown>;
}

export class CursorHost {
  private stateRoot?: string;
  private apiKey?: string;
  private store?: unknown;
  private agent?: CursorSdkAgent;
  private readonly runs = new Map<string, CursorRun>();

  constructor(
    private readonly sdk: CursorSdk,
    private readonly transport: CursorHostTransport
  ) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "agent/start":
        return this.startAgent(params);
      case "agent/send":
        return this.send(params);
      case "run/cancel":
        return this.cancel(params);
      case "models/list":
        return this.listModels();
      case "shutdown":
        return this.shutdown();
      default:
        throw new JsonRpcMethodNotFoundError(method);
    }
  }

  private initialize(params: unknown): { sdkVersion: string } {
    const parsed = initializeParamsSchema.parse(params);
    this.stateRoot = parsed.stateRoot;
    this.apiKey = parsed.apiKey;
    return { sdkVersion: this.sdk.version };
  }

  private async startAgent(params: unknown): Promise<{ agentId: string; resumed: boolean }> {
    const parsed = agentStartParamsSchema.parse(params);
    if (!this.stateRoot) throw new Error("Cursor host received agent/start before initialize");
    // The store is pinned under STATE_DIR so agent state never lands in
    // ~/.cursor/projects or the registered workspace.
    this.store = await this.sdk.openStore({ workspaceRef: parsed.cwd, stateRoot: this.stateRoot });

    const local = {
      cwd: parsed.cwd,
      settingSources: parsed.settingSources,
      sandboxOptions: { enabled: parsed.sandbox },
      autoReview: parsed.autoReview,
      store: this.store,
      ...(parsed.questionTool ? { customTools: this.customTools() } : {})
    };
    const options = {
      model: parsed.model,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      disallowedTools: parsed.disallowedTools,
      local
    };

    if (parsed.agentId) {
      this.agent = await this.sdk.Agent.resume(parsed.agentId, options);
      return { agentId: this.agent.agentId, resumed: true };
    }
    this.agent = await this.sdk.Agent.create(options);
    return { agentId: this.agent.agentId, resumed: false };
  }

  private async send(params: unknown): Promise<{ runId: string }> {
    const parsed = agentSendParamsSchema.parse(params);
    const agent = this.agent;
    if (!agent) throw new Error("Cursor host received agent/send before agent/start");
    let forwardedDeltaBytes = 0;

    const run = await agent.send(
      { text: parsed.text, ...(parsed.images ? { images: parsed.images } : {}) },
      {
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.mode ? { mode: parsed.mode } : {}),
        ...(parsed.force ? { local: { force: true } } : {}),
        onDelta: ({ update }) => {
          const bounded = boundedCursorShellDelta(
            update,
            MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN - forwardedDeltaBytes
          );
          if (!bounded) return;
          forwardedDeltaBytes += bounded.bytes;
          this.transport.notify("run/delta", { runId: run.id, update: bounded.update });
        }
      }
    );
    this.runs.set(run.id, run);
    void this.consumeRun(run);
    return { runId: run.id };
  }

  private async consumeRun(run: CursorRun): Promise<void> {
    try {
      for await (const message of run.stream()) {
        this.transport.notify("run/message", { runId: run.id, message });
      }
      const result = await run.wait();
      this.transport.notify("run/result", {
        runId: run.id,
        status: result.status,
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {})
      });
    } catch (error) {
      this.transport.notify("run/result", {
        runId: run.id,
        status: "error",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      this.runs.delete(run.id);
    }
  }

  private async cancel(params: unknown): Promise<Record<string, never>> {
    const parsed = runCancelParamsSchema.parse(params);
    const run = this.runs.get(parsed.runId);
    if (run) await run.cancel();
    return {};
  }

  private async listModels(): Promise<{ models: unknown[] }> {
    const models = await this.sdk.Cursor.models.list(this.apiKey ? { apiKey: this.apiKey } : undefined);
    return { models };
  }

  private shutdown(): Record<string, never> {
    this.agent?.close();
    return {};
  }

  /** The one custom tool: it relays the model's question to the backend. */
  private customTools() {
    return {
      [CURSOR_QUESTION_TOOL_NAME]: {
        description: CURSOR_QUESTION_TOOL_DESCRIPTION,
        inputSchema: CURSOR_QUESTION_INPUT_SCHEMA,
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const answer = await this.transport.request("question/ask", { input: args });
          return questionAskResultSchema.parse(answer).result;
        }
      }
    };
  }
}

/**
 * Wire a {@link CursorHost} to real stdio and the real SDK. Reads one JSON-RPC
 * frame per line; a frame with `method` and `id` is a backend request answered
 * here, a frame with `id` and no `method` is the answer to this host's own
 * `question/ask` request.
 */
export function runCursorHostStdio(sdk: CursorSdk = loadCursorSdk()): void {
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const write = (frame: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const transport: CursorHostTransport = {
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextRequestId++;
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      })
  };

  const host = new CursorHost(sdk, transport);

  const respond = (id: unknown, body: { result: unknown } | { error: { code: number; message: string } }): void => {
    write({ jsonrpc: "2.0", id, ...body });
  };

  const handleLine = (line: string): void => {
    const frame = parseCursorHostFrame(line);
    if (!frame) return;
    if (frame.method !== undefined) {
      const shutting = frame.method === "shutdown";
      void Promise.resolve()
        .then(() => host.handle(frame.method as string, frame.params))
        .then(
          (result) => {
            respond(frame.id, { result });
            if (shutting) process.exit(0);
          },
          (error: unknown) => {
            const code = error instanceof JsonRpcMethodNotFoundError ? -32601 : -32603;
            respond(frame.id, { error: { code, message: error instanceof Error ? error.message : String(error) } });
          }
        );
      return;
    }
    if ("result" in frame || "error" in frame) {
      if (typeof frame.id !== "number") return;
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id as number);
      if (frame.error) waiter.reject(new Error(frame.error.message ?? "Cursor host request failed"));
      else waiter.resolve(frame.result);
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) handleLine(line);
      index = buffer.indexOf("\n");
    }
  });

  // `run.cancel()` settles promptly but leaves one unhandled AbortError behind
  // (fact 8), which Node's default policy would turn into a process exit. Log
  // that one and let everything else still fail loud.
  process.on("unhandledRejection", (reason: unknown) => {
    if (reason instanceof Error && reason.name === "AbortError") {
      process.stderr.write(`Cursor host absorbed a post-cancel AbortError: ${reason.message}\n`);
      return;
    }
    throw reason;
  });
}

/** Parse one complete stdin frame without trusting `JSON.parse`'s output type. */
export function parseCursorHostFrame(line: string): CursorHostIncomingFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = cursorHostIncomingFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

if (require.main === module) {
  runCursorHostStdio();
}
