import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/// SPIKE (2026-06-19) D0 — LSP feasibility. Minimal Language Server Protocol stdio
/// client used to prove the AgentRoom backend can host a real language server
/// (sourcekit-lsp) and round-trip LSP requests bounded to a registered workspace.
///
/// This is throwaway feasibility code: it is NOT imported by the server, adds no
/// route, and is not flag-wired. A production path would put an `LspSupervisor`
/// behind a runner/harness-style boundary. Transport details mirror the stdio
/// JSON-RPC framing already used by `CodexAppServerRunner`, but with LSP's
/// `Content-Length` header framing.

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type LspNotificationHandler = (method: string, params: unknown) => void;

export class LspStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<LspNotificationHandler>();
  private closed = false;

  /// Spawn the language server with its cwd bound to `cwd` (the registered
  /// workspace root in production). No shell; fixed argv only.
  constructor(command: string, args: readonly string[], cwd: string) {
    this.child = spawn(command, args, { cwd });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("error", (error: Error) => this.failAll(error));
    this.child.on("exit", () => this.failAll(new Error("language server exited")));
  }

  /// Send an LSP request and resolve with its result (rejects on error/timeout).
  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("LSP client is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP request "${method}" timed out`));
      }, timeoutMs);
      timer.unref();
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /// Send an LSP notification (no response expected).
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler: LspNotificationHandler): void {
    this.notificationHandlers.add(handler);
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error("LSP client disposed"));
    this.child.kill("SIGKILL");
  }

  private send(message: JsonRpcMessage): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
    this.child.stdin.write(Buffer.concat([header, payload]));
  }

  /// Accumulate stdout and emit each complete `Content-Length`-framed message,
  /// tolerating messages split across or batched within chunks.
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header block — drop it and resync rather than stall.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // wait for the rest
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      return;
    }

    // Response to one of our requests.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "LSP error"));
      else pending.resolve(message.result);
      return;
    }

    // Server -> client request (e.g. client/registerCapability,
    // window/workDoneProgress/create): ack with a null result so the server's
    // init sequence is not blocked. (D0 does not implement these capabilities.)
    if (message.method !== undefined && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }

    // Server -> client notification (publishDiagnostics, logMessage, $/progress…).
    if (message.method !== undefined) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
