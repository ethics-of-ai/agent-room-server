import { Socket } from "node:net";
import type { Duplex } from "node:stream";

const VERSION = 1;
const MAX_FRAME_BYTES = 512 * 1024;

interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

interface ToolExecution {
  callId: string;
  signal: AbortSignal;
}

interface CordisContext {
  tools: {
    register(definition: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      output: {
        schema: Record<string, unknown>;
        render(argumentsValue: unknown, value: unknown): Array<{ type: "text"; text: string }>;
      };
      execute(argumentsValue: unknown, execution: ToolExecution): Promise<string>;
    }): () => void;
    /** Deny a call before its body runs by returning a reason; no guard can allow what another denied. */
    guard?(guard: (execution: { name: string }) => string | undefined): () => void;
  };
  effect(setup: () => () => void): void;
  /** Reads a service the plugin does not declare, such as the job registry. */
  get?(name: string): unknown;
}

interface JobRegistry {
  kill(jobId: string, caller: string, reason: string): "requested" | "already-finished";
}

interface SubagentService {
  interrupt(childSessionId: string, authority: { kind: "user"; parentSessionId: string }): void;
}

const STOP_REASON = "stopped from AgentRoom";
/** The managed graph's delegation tool; a custom graph that names it otherwise is not paused. */
const SUBAGENT_TOOL = "subagent";
const SUBAGENT_PAUSE_REASON =
  "AgentRoom paused new subagents because you have started several turns in a row on your own. Finish with the work already running; a person's next message lifts the pause.";

export const name = "agentroom-tools";
export const inject = ["tools"];

export function apply(ctx: CordisContext): void {
  // Custom compositions may include the plugin while the feature is disabled.
  // Only the parent can grant the inherited pipe; absence leaves no tools.
  if (!process.env.AGENTROOM_DEEPSEEK_TOOLS_FD) return;
  const fd = Number.parseInt(process.env.AGENTROOM_DEEPSEEK_TOOLS_FD ?? "3", 10);
  serveAgentRoomRelay(ctx, new Socket({ fd, readable: true, writable: true }));
}

/**
 * Serve the backend's relay on one pipe: register the tool catalog it sends,
 * forward bound tool calls to it, and stop background work it names. A job
 * is killed as the session that owns it and a subagent is interrupted for
 * the session that started it, so the registry's own session fence applies.
 * While the backend pauses subagents, a guard refuses the delegation tool.
 */
export function serveAgentRoomRelay(ctx: CordisContext, socket: Duplex): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let catalogInstalled = false;
  let binding: { runId: string; allowedNames: Set<string> } | undefined;
  const pending = new Map<string, { runId: string; resolve(value: string): void; reject(error: Error): void }>();
  const disposers: Array<() => void> = [];
  let subagentsPaused = false;
  const unguard = ctx.tools.guard?.((execution) => subagentsPaused && execution.name === SUBAGENT_TOOL ? SUBAGENT_PAUSE_REASON : undefined);
  if (unguard) disposers.push(unguard);

  const send = (message: unknown): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };
  const failPending = (message: string, runId?: string): void => {
    for (const [callId, call] of pending) {
      if (runId !== undefined && call.runId !== runId) continue;
      pending.delete(callId);
      call.reject(new Error(message));
    }
  };
  const install = (catalog: CatalogTool[]): void => {
    if (catalogInstalled) throw new Error("AgentRoom tools catalog may be installed only once");
    catalogInstalled = true;
    for (const tool of catalog) {
      disposers.push(ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
          // The wire result is serialized text, even when the logical tool
          // describes an object. Cordis compiles only a JSON-Schema subset;
          // the shared backend dispatcher enforces the result-size bound.
          schema: { type: "string" },
          render: (_argumentsValue, value) => [{ type: "text", text: String(value) }]
        },
        execute: async (argumentsValue, execution) => {
          const active = binding;
          if (!active || !active.allowedNames.has(tool.name)) {
            throw new Error("AgentRoom tool is not bound to this turn");
          }
          const callId = String(execution.callId);
          if (pending.has(callId)) throw new Error("AgentRoom tool call id is already active");
          const response = new Promise<string>((resolve, reject) => {
            pending.set(callId, { runId: active.runId, resolve, reject });
          });
          const cancel = () => send({ version: VERSION, type: "cancel", runId: active.runId, callId });
          execution.signal.addEventListener("abort", cancel, { once: true });
          send({
            version: VERSION,
            type: "invoke",
            runId: active.runId,
            callId,
            name: tool.name,
            arguments: argumentsValue
          });
          try {
            return await response;
          } finally {
            execution.signal.removeEventListener("abort", cancel);
            pending.delete(callId);
          }
        }
      }));
    }
    send({ version: VERSION, type: "ready", names: catalog.map((tool) => tool.name) });
  };
  const stop = (target: any): "stopped" | "unknown_task" => {
    try {
      if (target?.kind === "job") {
        const jobs = ctx.get?.("jobs") as JobRegistry | undefined;
        return jobs?.kill(String(target.jobId), String(target.owner), STOP_REASON) === "requested" ? "stopped" : "unknown_task";
      }
      if (target?.kind === "subagent") {
        const subagents = ctx.get?.("subagents") as SubagentService | undefined;
        if (!subagents) return "unknown_task";
        subagents.interrupt(String(target.childSessionId), { kind: "user", parentSessionId: String(target.parentSessionId) });
        return "stopped";
      }
    } catch {
      // An id the runtime no longer knows is a task that already ended.
    }
    return "unknown_task";
  };
  const handle = (message: any): void => {
    if (!message || message.version !== VERSION || typeof message.type !== "string") {
      throw new Error("Invalid AgentRoom tools envelope");
    }
    if (message.type === "catalog") {
      if (!Array.isArray(message.catalog)) throw new Error("Invalid AgentRoom tools catalog");
      install(message.catalog as CatalogTool[]);
      return;
    }
    if (message.type === "bind") {
      if (!catalogInstalled || binding) throw new Error("Invalid AgentRoom tools binding");
      binding = { runId: String(message.runId), allowedNames: new Set(message.allowedNames as string[]) };
      return;
    }
    if (message.type === "unbind") {
      const active = binding;
      if (!active || active.runId !== message.runId) return;
      failPending("AgentRoom tool turn ended", active.runId);
      binding = undefined;
      return;
    }
    if (message.type === "subagents") {
      subagentsPaused = message.paused === true;
      return;
    }
    if (message.type === "stop") {
      send({ version: VERSION, type: "stopped", requestId: Number(message.requestId), result: stop(message.target) });
      return;
    }
    if (message.type === "result") {
      const call = pending.get(String(message.callId));
      if (!call || call.runId !== message.runId || typeof message.result !== "string") return;
      pending.delete(String(message.callId));
      call.resolve(message.result);
      return;
    }
    throw new Error("Unknown AgentRoom tools envelope");
  };

  socket.on("data", (chunk: string) => {
    try {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) throw new Error("AgentRoom tools frame too large");
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("AgentRoom tools frame too large");
        if (line.trim()) handle(JSON.parse(line));
      }
    } catch {
      socket.destroy();
    }
  });
  socket.on("close", () => failPending("AgentRoom tools pipe closed"));
  socket.on("error", () => failPending("AgentRoom tools pipe failed"));
  ctx.effect(() => () => {
    binding = undefined;
    failPending("AgentRoom tools plugin disposed");
    for (const dispose of disposers.splice(0)) dispose();
    socket.destroy();
  });
  send({ version: VERSION, type: "hello" });
}
