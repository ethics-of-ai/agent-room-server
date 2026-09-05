import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/// Evidence-only LSP client. It records enough transport behavior to maintain the
/// production boundary without exposing a general JSON-RPC tunnel in AgentRoom.

export type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LspWireStats {
  inboundFrames: number;
  outboundFrames: number;
  inboundPayloadBytes: number;
  outboundPayloadBytes: number;
  largestInboundPayloadBytes: number;
  largestOutboundPayloadBytes: number;
}

export interface LspExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LspRequestHandle {
  id: JsonRpcId;
  promise: Promise<unknown>;
}

export type LspNotificationHandler = (method: string, params: unknown) => void;
export type LspServerRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export interface LspStdioClientOptions {
  env?: NodeJS.ProcessEnv;
  maxStderrBytes?: number;
  serverRequestHandler?: LspServerRequestHandler;
}

export class LspStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<LspNotificationHandler>();
  private readonly serverRequestMethods = new Set<string>();
  private readonly notificationMethods = new Set<string>();
  private readonly maxStderrBytes: number;
  private readonly serverRequestHandler?: LspServerRequestHandler;
  private readonly exitPromise: Promise<LspExit>;
  private resolveExit!: (exit: LspExit) => void;
  private stderrBuffer = Buffer.alloc(0);
  private stderrWasTruncated = false;
  private closed = false;
  private exited = false;
  private stats: LspWireStats = {
    inboundFrames: 0,
    outboundFrames: 0,
    inboundPayloadBytes: 0,
    outboundPayloadBytes: 0,
    largestInboundPayloadBytes: 0,
    largestOutboundPayloadBytes: 0
  };

  constructor(
    command: string,
    args: readonly string[],
    cwd: string,
    options: LspStdioClientOptions = {}
  ) {
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.serverRequestHandler = options.serverRequestHandler;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = spawn(command, args, { cwd, env: options.env });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.on("error", (error: Error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.resolveExit({ code, signal });
      this.failAll(new Error(`language server exited (${signal ?? code ?? "unknown"})`));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get wireStats(): Readonly<LspWireStats> {
    return { ...this.stats };
  }

  get observedServerRequestMethods(): readonly string[] {
    return [...this.serverRequestMethods].sort();
  }

  get observedNotificationMethods(): readonly string[] {
    return [...this.notificationMethods].sort();
  }

  get stderrTail(): string {
    return this.stderrBuffer.toString("utf8");
  }

  get stderrTruncated(): boolean {
    return this.stderrWasTruncated;
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    return this.requestWithHandle(method, params, timeoutMs).promise;
  }

  requestWithHandle(method: string, params: unknown, timeoutMs = 10_000): LspRequestHandle {
    if (this.closed) {
      return { id: -1, promise: Promise.reject(new Error("LSP client is closed")) };
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP request "${method}" timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return { id, promise };
  }

  cancelRequest(id: JsonRpcId): void {
    this.notify("$/cancelRequest", { id });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler: LspNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    this.closed = true;
    return this.child.kill(signal);
  }

  async waitForExit(timeoutMs = 3_000): Promise<LspExit> {
    if (this.exited) return this.exitPromise;
    return Promise.race([
      this.exitPromise,
      new Promise<LspExit>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("language server exit timed out")), timeoutMs);
        timer.unref();
      })
    ]);
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error("LSP client disposed"));
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private send(message: JsonRpcMessage): void {
    if (this.exited || this.child.stdin.destroyed) return;
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
    this.stats.outboundFrames += 1;
    this.stats.outboundPayloadBytes += payload.length;
    this.stats.largestOutboundPayloadBytes = Math.max(
      this.stats.largestOutboundPayloadBytes,
      payload.length
    );
    this.child.stdin.write(Buffer.concat([header, payload]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.stats.inboundFrames += 1;
      this.stats.inboundPayloadBytes += length;
      this.stats.largestInboundPayloadBytes = Math.max(this.stats.largestInboundPayloadBytes, length);
      this.dispatch(body);
    }
  }

  private onStderr(chunk: Buffer): void {
    if (this.maxStderrBytes === 0) return;
    const combined = Buffer.concat([this.stderrBuffer, chunk]);
    if (combined.length > this.maxStderrBytes) {
      this.stderrWasTruncated = true;
      this.stderrBuffer = combined.subarray(combined.length - this.maxStderrBytes);
    } else {
      this.stderrBuffer = combined;
    }
  }

  private dispatch(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? "LSP error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method !== undefined && message.id !== undefined) {
      this.serverRequestMethods.add(message.method);
      void this.answerServerRequest(message);
      return;
    }

    if (message.method !== undefined) {
      this.notificationMethods.add(message.method);
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
  }

  private async answerServerRequest(message: JsonRpcMessage): Promise<void> {
    try {
      if (!this.serverRequestHandler) throw new Error("unsupported server request");
      const result = await this.serverRequestHandler(message.method as string, message.params);
      this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: error instanceof Error ? error.message : "unsupported server request" }
      });
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
