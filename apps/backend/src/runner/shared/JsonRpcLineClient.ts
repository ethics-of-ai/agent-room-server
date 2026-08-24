import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../../logging/logger";

/**
 * Newline-delimited JSON-RPC over a child process's stdio: one compact JSON
 * frame per `\n`-terminated line, a pending-request map, and notification
 * fan-out.
 *
 * It lives here rather than in one adapter because two runners speak this exact
 * framing to a child the operator installed — the Codex app-server and the
 * DeepSeek Harness SDK runtime — and two adapters arriving at the same shape is
 * what produced `runner/shared/PersistentRunnerSessionHost.ts` too. What it
 * deliberately is *not* is the transport for an arbitrary operator-supplied
 * binary: that is
 * `runner/acp/AcpStdioClient.ts`, which bounds frame size, nesting depth, output
 * volume, and every request's duration precisely because its child is not a
 * program the operator installed as a named runner. The comment at the top of
 * that file is the full reasoning, and it still holds — this module having two
 * callers does not make it the general answer.
 *
 * `label` names the child in the two errors this client raises, so a rejected
 * request says which runner's process went away. It is required rather than
 * defaulted: a future caller that forgot it would otherwise report another
 * runner's name.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Thrown by a request handler for a method it does not serve. The child gets
 * the standard `-32601` rather than a hang: a server→client request nobody
 * answers is what wedged a turn before the dispatcher existed.
 */
export class JsonRpcMethodNotFoundError extends Error {
  constructor(readonly method: string) {
    super(`Method not found: ${method}`);
  }
}

export type JsonRpcRequestHandler = (request: JsonRpcRequest) => unknown | Promise<unknown>;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

export class JsonRpcLineClient {
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  private requestHandler?: JsonRpcRequestHandler;
  private nextId = 1;
  private stdoutBuffer = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly label: string
  ) {
    // stdin EPIPE (the child dying mid-write) must not surface as an unhandled
    // stream error and crash the backend; the per-write callbacks and the close
    // handler below already reject the affected requests.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk.toString("utf8")));
    child.on("close", () => this.rejectPending(new Error(`${this.label} connection closed`)));
    child.on("error", (error) => this.rejectPending(error));
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandlers.add(handler);
  }

  /**
   * Serve the child's own requests (a frame carrying both `method` and `id`).
   * One handler: it returns the result, or throws `JsonRpcMethodNotFoundError`
   * for a method it does not serve. With no handler registered every such
   * request is refused with `-32601`, which is strictly better than the silence
   * that preceded this — a child awaiting an answer nobody will send holds its
   * turn open forever.
   */
  onRequest(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  /** Answer one of the child's requests. */
  respond(id: JsonRpcId, response: { result: unknown } | { error: { code: number; message: string } }): void {
    const frame: JsonRpcResponse = { id, ...response };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, () => undefined);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  dispose(): void {
    this.notificationHandlers.clear();
    this.rejectPending(new Error(`${this.label} client disposed`));
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // Slice each line directly instead of re-slicing the shrinking remainder,
    // which copied O(lines x buffer) characters per multi-line chunk.
    let start = 0;
    let index = this.stdoutBuffer.indexOf("\n", start);
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(start, index).trim();
      if (line.length > 0) this.handleLine(line);
      start = index + 1;
      index = this.stdoutBuffer.indexOf("\n", start);
    }
    if (start > 0) this.stdoutBuffer = this.stdoutBuffer.slice(start);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if ("method" in message && !("id" in message)) {
      for (const handler of this.notificationHandlers) handler(message);
      return;
    }

    if ("method" in message && "id" in message) {
      this.serveRequest(message);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private serveRequest(request: JsonRpcRequest): void {
    const handler = this.requestHandler;
    const refuse = (code: number, message: string): void => {
      logger.warn({ label: this.label, method: request.method, code }, "Refused a JSON-RPC request from the child");
      this.respond(request.id, { error: { code, message } });
    };
    if (!handler) {
      refuse(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      return;
    }
    void Promise.resolve()
      .then(() => handler(request))
      .then(
        (result) => this.respond(request.id, { result }),
        (error: unknown) => {
          if (error instanceof JsonRpcMethodNotFoundError) {
            refuse(JSON_RPC_METHOD_NOT_FOUND, error.message);
            return;
          }
          refuse(JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
        }
      );
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
