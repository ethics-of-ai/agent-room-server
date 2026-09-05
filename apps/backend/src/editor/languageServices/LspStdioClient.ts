import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSecrets } from "../../util/redactSecrets";
import { LanguageServiceError } from "./errors";
import type { LanguageServiceLimits } from "./limits";
import type { LanguageServiceServerRequestPolicy, LanguageServiceSpawner } from "./types";

type JsonRpcId = number | string;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface LspRequestHandle {
  id: number;
  promise: Promise<unknown>;
}

export interface LspClientHandlers {
  onNotification(method: string, params: unknown): void;
  onFatal(error: Error): void;
}

export const defaultLanguageServiceSpawner: LanguageServiceSpawner = {
  spawn: (command, args, options) => spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  })
};

/** Bounded Content-Length JSON-RPC transport. It exposes no arbitrary RPC seam. */
export class LspStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private shuttingDown = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(input: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    limits: LanguageServiceLimits;
    serverRequests?: LanguageServiceServerRequestPolicy;
    handlers: LspClientHandlers;
    spawner?: LanguageServiceSpawner;
  }) {
    this.limits = input.limits;
    this.serverRequests = input.serverRequests ?? {};
    this.handlers = input.handlers;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child = (input.spawner ?? defaultLanguageServiceSpawner).spawn(
      input.command,
      input.args,
      { cwd: input.cwd, env: input.env }
    );
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stdout.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.exited = true;
      this.resolveExit();
      if (this.shuttingDown) {
        this.closed = true;
        this.rejectPending(new LanguageServiceError("server_failed", "Language server exited during shutdown"));
      } else if (!this.closed) {
        this.fail(new Error(`Language server exited (${signal ?? code ?? "unknown"})`));
      }
    });
  }

  private readonly limits: LanguageServiceLimits;
  private readonly serverRequests: LanguageServiceServerRequestPolicy;
  private readonly handlers: LspClientHandlers;

  get diagnosticTail(): string {
    return redactSecrets(this.stderr.toString("utf8")).trim();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.requestWithHandle(method, params, timeoutMs).promise;
  }

  requestWithHandle(method: string, params: unknown, timeoutMs: number): LspRequestHandle {
    if (this.closed) {
      return { id: -1, promise: Promise.reject(new LanguageServiceError("server_failed", "Language server is closed")) };
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        try {
          this.notify("$/cancelRequest", { id });
        } catch {
          // A stalled peer may exhaust its write budget while cancellation is
          // being sent. The request must still settle at its deadline.
        } finally {
          reject(new LanguageServiceError("timeout", "Language-service request timed out"));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    return { id, promise };
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  cancel(id: number): void {
    if (!this.pending.has(id)) return;
    try {
      this.notify("$/cancelRequest", { id });
    } catch (error) {
      // Cancellation is best-effort; a failed write closes the service but
      // must not interrupt its owner's document/lease cleanup.
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.shuttingDown = true;
    const deadline = Date.now() + this.limits.shutdownTimeoutMs;
    let exitTimer: NodeJS.Timeout | undefined;
    try {
      await this.request("shutdown", null, Math.max(1, deadline - Date.now()));
      this.notify("exit", null);
      await Promise.race([
        this.exitPromise,
        new Promise<void>((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error("Language server did not exit")),
            Math.max(1, deadline - Date.now())
          );
          exitTimer.unref?.();
        })
      ]);
      this.closed = true;
    } catch {
      this.dispose("Language server shutdown timed out", true);
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
    }
  }

  dispose(reason = "Language server closed", force = false): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new LanguageServiceError("server_failed", reason));
    if (!this.exited) {
      this.child.kill(force ? "SIGKILL" : "SIGTERM");
      if (force) return;
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGKILL");
      }, this.limits.shutdownTimeoutMs);
      timer.unref?.();
    }
  }

  private write(frame: unknown): void {
    const payload = Buffer.from(JSON.stringify(frame), "utf8");
    if (payload.byteLength > this.limits.maxFrameBytes) {
      throw new LanguageServiceError("outbound_limit", "Language-server frame exceeded the size limit");
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new LanguageServiceError("server_failed", "Language server is not writable");
    }
    const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii");
    // Node retains writes after backpressure, including the active write. Bound
    // that queue before enqueueing; a stalled child cannot retain every draft.
    if (this.child.stdin.writableLength + header.byteLength + payload.byteLength > this.limits.maxQueuedStdinBytes) {
      const error = new LanguageServiceError("outbound_limit", "Language-server input queue exceeded the size limit");
      this.fail(error);
      throw error;
    }
    this.child.stdin.write(Buffer.concat([header, payload]));
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.byteLength > 8 * 1024) this.protocolFailure("Language server sent an oversized header");
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
      if (lengths.length !== 1) {
        this.protocolFailure("Language server sent an invalid Content-Length header");
        return;
      }
      const length = Number(lengths[0][1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.limits.maxFrameBytes) {
        this.protocolFailure("Language server frame exceeded the size limit");
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
      if (this.closed) return;
    }
  }

  private dispatch(body: Buffer): void {
    let frame: JsonRpcFrame;
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      frame = parsed as JsonRpcFrame;
    } catch {
      this.protocolFailure("Language server sent invalid JSON-RPC");
      return;
    }
    if (frame.jsonrpc !== "2.0") {
      this.protocolFailure("Language server sent an unsupported JSON-RPC version");
      return;
    }

    if (frame.id !== undefined && typeof frame.method === "string") {
      this.answerServerRequest(frame.id, frame.method, frame.params);
      return;
    }
    if (typeof frame.method === "string") {
      try {
        this.handlers.onNotification(frame.method, frame.params);
      } catch {
        this.protocolFailure("Language-server notification could not be normalized");
      }
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(frame, "result");
    const hasError = Object.prototype.hasOwnProperty.call(frame, "error");
    if (typeof frame.id !== "number" || hasResult === hasError) {
      this.protocolFailure("Language server sent an invalid JSON-RPC envelope");
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    let errorMessage: string | undefined;
    if (hasError) {
      const error = frame.error && typeof frame.error === "object" && !Array.isArray(frame.error)
        ? frame.error as { code?: unknown; message?: unknown }
        : undefined;
      if (!error || typeof error.code !== "number" || typeof error.message !== "string") {
        this.protocolFailure("Language server sent an invalid JSON-RPC error");
        return;
      }
      errorMessage = error.message;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (errorMessage !== undefined) {
      pending.reject(new LanguageServiceError("server_failed", redactSecrets(errorMessage).slice(0, 500)));
    } else {
      pending.resolve(frame.result);
    }
  }

  private answerServerRequest(id: unknown, method: string, params: unknown): void {
    try {
      this.writeServerRequestAnswer(id, method, params);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private writeServerRequestAnswer(id: unknown, method: string, params: unknown): void {
    if ((typeof id !== "number" && typeof id !== "string") || (typeof id === "string" && id.length > 128)) {
      this.protocolFailure("Language server sent an invalid request id");
      return;
    }
    if (method === "window/workDoneProgress/create"
      && this.serverRequests.workDoneProgressCreate === "null") {
      const token = (params as { token?: unknown } | null)?.token;
      if ((typeof token === "string" && token.length <= 128) || typeof token === "number") {
        this.write({ jsonrpc: "2.0", id, result: null });
      } else {
        this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid progress token" } });
      }
      return;
    }
    if (method === "workspace/configuration"
      && this.serverRequests.workspaceConfiguration === "null_per_item") {
      const items = (params as { items?: unknown } | null)?.items;
      if (Array.isArray(items) && items.length <= 32) {
        this.write({ jsonrpc: "2.0", id, result: items.map(() => null) });
      } else {
        this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid configuration request" } });
      }
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported" } });
  }

  private onStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderr, chunk]);
    this.stderr = combined.byteLength <= this.limits.maxStderrBytes
      ? combined
      : combined.subarray(combined.byteLength - this.limits.maxStderrBytes);
  }

  private protocolFailure(message: string): void {
    this.fail(new LanguageServiceError("server_failed", message));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    if (!this.exited) this.child.kill("SIGKILL");
    this.handlers.onFatal(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
