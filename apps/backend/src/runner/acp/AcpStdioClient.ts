import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "../../util/redactSecrets";
import { DEFAULT_PERMISSION_TIMEOUT_MS } from "../shared/PendingPermissionRequests";

/**
 * A bounded NDJSON JSON-RPC transport for an external ACP agent.
 *
 * The shared `runner/shared/JsonRpcLineClient.ts` is the same protocol shape,
 * and this is deliberately **not** another caller of it. That client talks to a
 * binary the operator installed as a *named runner*, with the backend's whole
 * environment and no volume limits, because the failure modes it guards are
 * "the child died". This one talks to an arbitrary operator-supplied
 * program, so every unbounded property of that client is a limit here: frame
 * size, nesting depth, total output volume, stderr volume, and a timeout on
 * every request with a kill fallback behind it. Merging them would mean either
 * relaxing these bounds or imposing them where they are not needed.
 *
 * A breach is not recoverable and is not negotiated: the child is killed and
 * every pending request rejects with a bounded reason. A program that has
 * already sent a 4 MB line is not going to be talked back into the protocol.
 */

export interface AcpLimits {
  /** Largest single NDJSON frame, in bytes. */
  readonly maxFrameBytes: number;
  /** Largest nesting depth of a parsed frame. */
  readonly maxDepth: number;
  /** Total stdout bytes one child may produce before it is considered runaway. */
  readonly maxTotalOutputBytes: number;
  /**
   * Total *decoded* image bytes one prompt may carry.
   *
   * The only outbound bound, and it exists because ACP has no local-file image
   * source: an accepted attachment is inlined as base64 on a single line. The
   * upload cap alone does not bound it — eight 10 MB attachments would be
   * ~107 MB of base64 written to an arbitrary child in one frame.
   */
  readonly maxPromptImageBytes: number;
  /** Bounded stderr tail retained for diagnostics. */
  readonly maxStderrTailBytes: number;
  /** Handshake (`initialize` + `session/new`) budget. */
  readonly handshakeTimeoutMs: number;
  /** One `session/prompt`. */
  readonly turnTimeoutMs: number;
  /** How long a cancel is given to settle the turn before the child is killed. */
  readonly cancelTimeoutMs: number;
  /**
   * How long a permission request waits for a human under the `ask` posture
   * before the configured policy answers it instead. Bounded because a turn
   * that blocks forever on an absent operator is a worse failure than a
   * refusal; it is not a transport bound, so a breach kills nothing.
   */
  readonly permissionTimeoutMs: number;
  /** How long a killed child is given to exit before SIGKILL. */
  readonly shutdownTimeoutMs: number;
}

export const DEFAULT_ACP_LIMITS: AcpLimits = {
  maxFrameBytes: 1024 * 1024,
  maxDepth: 64,
  maxTotalOutputBytes: 64 * 1024 * 1024,
  maxPromptImageBytes: 16 * 1024 * 1024,
  maxStderrTailBytes: 8 * 1024,
  handshakeTimeoutMs: 60_000,
  turnTimeoutMs: 30 * 60_000,
  cancelTimeoutMs: 10_000,
  permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
  shutdownTimeoutMs: 5_000
};

export class AcpProtocolViolation extends Error {}

export interface AcpClientHandlers {
  /** An agent notification (`session/update`, …). */
  onNotification(method: string, params: unknown): void;
  /**
   * An agent→client request. The returned value is sent as the result; throwing
   * sends a JSON-RPC error. Every method AgentRoom does not implement — the
   * declined `fs/*` and `terminal/*` among them — lands here and is refused.
   */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** The transport failed terminally; the child is already being torn down. */
  onFatal(error: Error): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Depth-check a parsed frame.
 *
 * `JSON.parse` has already bounded the work by the frame cap, so this is not
 * about parse cost — it is about what the value is handed to afterwards. A
 * deeply nested object reaches the canonical mapper, the bounded `native` blob,
 * and durable audit, each of which walks it.
 */
function withinDepth(value: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (Array.isArray(value)) {
    return value.every((item) => withinDepth(item, maxDepth, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((item) =>
      withinDepth(item, maxDepth, depth + 1)
    );
  }
  return true;
}

export class AcpStdioClient {
  private readonly pending = new Map<number, Pending>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private buffer = "";
  private totalOutputBytes = 0;
  private stderrTail = "";
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly limits: AcpLimits,
    private readonly handlers: AcpClientHandlers
  ) {
    // A child that dies mid-write must not surface as an unhandled stream error.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + this.stderrDecoder.write(chunk)).slice(-this.limits.maxStderrTailBytes);
    });
    child.on("close", (code, signal) =>
      this.fail(new Error(`ACP agent exited (code=${code ?? "null"} signal=${signal ?? "null"})`))
    );
    child.on("error", (error) => this.fail(error));
  }

  /**
   * The child's own last words, redacted.
   *
   * An agent's stderr can quote its own configuration, so this passes through
   * the shared helper before it reaches an error, an event, or durable audit —
   * the same rule the Codex stderr tail follows, and for the same reason: these
   * strings surface on reads that the mutating-method preHandler does not gate.
   */
  get diagnosticTail(): string {
    return redactSecrets(this.stderrTail).trim();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("ACP client disposed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out request means the agent is not answering its own
        // protocol. There is no partial recovery: the child goes.
        this.fail(new Error(`ACP request timed out: ${method}`));
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Kill the child and reject everything outstanding. Idempotent. */
  dispose(reason = "ACP client disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new Error(reason));
    this.killChild();
  }

  private write(message: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.disposed) return;
    this.totalOutputBytes += chunk.byteLength;
    if (this.totalOutputBytes > this.limits.maxTotalOutputBytes) {
      this.fail(new AcpProtocolViolation("ACP agent exceeded its total output budget"));
      return;
    }
    // stdout chunks may end inside a multi-byte scalar. StringDecoder retains
    // the incomplete bytes until the next chunk instead of inserting U+FFFD
    // into otherwise valid JSON and corrupting user-visible output.
    this.buffer += this.stdoutDecoder.write(chunk);
    let start = 0;
    let index = this.buffer.indexOf("\n", start);
    while (index >= 0) {
      const line = this.buffer.slice(start, index).trim();
      start = index + 1;
      if (line.length > 0 && !this.handleLine(line)) return;
      index = this.buffer.indexOf("\n", start);
    }
    this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;
    // An unterminated line past the frame cap is a violation on its own: waiting
    // for a newline that may never come is how a peer grows backend memory.
    if (Buffer.byteLength(this.buffer, "utf8") > this.limits.maxFrameBytes) {
      this.fail(new AcpProtocolViolation("ACP agent exceeded the maximum frame size"));
    }
  }

  /** @returns false when the transport has failed and parsing must stop. */
  private handleLine(line: string): boolean {
    if (Buffer.byteLength(line, "utf8") > this.limits.maxFrameBytes) {
      this.fail(new AcpProtocolViolation("ACP agent exceeded the maximum frame size"));
      return false;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new AcpProtocolViolation("ACP agent sent a frame that is not JSON"));
      return false;
    }
    if (!withinDepth(message, this.limits.maxDepth)) {
      this.fail(new AcpProtocolViolation("ACP agent sent a frame nested past the depth limit"));
      return false;
    }
    if (!message || typeof message !== "object") {
      this.fail(new AcpProtocolViolation("ACP agent sent a non-object frame"));
      return false;
    }

    const frame = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

    if (frame.id !== undefined && typeof frame.method === "string") {
      void this.dispatchRequest(frame.id, frame.method, frame.params);
      return true;
    }
    if (typeof frame.method === "string") {
      this.handlers.onNotification(frame.method, frame.params);
      return true;
    }
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return true;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        const error = frame.error as { message?: unknown };
        pending.reject(
          new Error(redactSecrets(typeof error.message === "string" ? error.message : "ACP request failed"))
        );
      } else {
        pending.resolve(frame.result);
      }
    }
    return true;
  }

  private async dispatchRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: redactSecrets(error instanceof Error ? error.message : String(error))
        }
      });
    }
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(error);
    this.killChild();
    this.handlers.onFatal(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * SIGTERM, then SIGKILL if the child has not exited. A program that ignores
   * the first signal is exactly the program that must not be left running.
   */
  private killChild(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, this.limits.shutdownTimeoutMs);
    timer.unref?.();
  }
}
