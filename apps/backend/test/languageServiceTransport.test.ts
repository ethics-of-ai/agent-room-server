import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspStdioClient } from "../src/editor/languageServices/LspStdioClient";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS, type LanguageServiceLimits } from "../src/editor/languageServices/limits";
import { LanguageServiceError } from "../src/editor/languageServices/errors";
import type { LanguageServiceServerRequestPolicy } from "../src/editor/languageServices/types";

const fixture = resolve(__dirname, "fixtures/fakeLanguageServer.mjs");
const roots: string[] = [];

async function testRoot(): Promise<{ root: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-language-transport-"));
  roots.push(root);
  return { root, log: join(root, "server.ndjson") };
}

function client(
  root: string,
  log: string,
  mode: string,
  onFatal = (_error: Error): void => undefined,
  serverRequests: LanguageServiceServerRequestPolicy = {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  }
): LspStdioClient {
  return new LspStdioClient({
    command: process.execPath,
    args: [fixture, log, mode],
    cwd: root,
    env: { PATH: process.env.PATH },
    limits: {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      initializeTimeoutMs: 1_000,
      featureTimeoutMs: 50,
      shutdownTimeoutMs: 500
    },
    serverRequests,
    handlers: { onNotification: () => undefined, onFatal }
  });
}

async function initialize(lsp: LspStdioClient): Promise<void> {
  await lsp.request("initialize", { capabilities: {} }, 1_000);
  lsp.notify("initialized", {});
}

async function logEntries(path: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(path, "utf8").catch(() => "");
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production LSP transport", () => {
  function stalledReader(limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS) {
    const child = new EventEmitter();
    const stdin = new Writable({ write(_chunk, _encoding, _callback) {} });
    const state: { killed: boolean; fatal?: Error } = { killed: false };
    const peer = Object.assign(child, {
      stdin, stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => { state.killed = true; return true; }
    });
    const lsp = new LspStdioClient({
      command: "fixture", args: [], cwd: "/tmp", env: {}, limits,
      spawner: { spawn: () => peer as unknown as ChildProcessWithoutNullStreams },
      handlers: { onNotification: () => undefined, onFatal: (error) => { state.fatal = error; } }
    });
    return { lsp, stdin, state };
  }

  it("settles a request without throwing from cancellation when its peer is stalled", async () => {
    const { lsp, stdin, state } = stalledReader({ ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxQueuedStdinBytes: 256 });
    const request = lsp.requestWithHandle("test", {}, 1_000);
    const rejected = expect(request.promise).rejects.toMatchObject({ code: "outbound_limit" });
    try {
      lsp.notify("fill", { text: "x".repeat(64) });
      expect(state.killed).toBe(false);
      expect(() => lsp.cancel(request.id)).not.toThrow();
      await rejected;
      expect(state.killed).toBe(true);
    } finally {
      lsp.dispose("test complete", true);
      stdin.destroy();
    }
  });

  it("terminates a stalled reader before queued document updates exceed four MiB", () => {
    const { lsp, stdin, state } = stalledReader();
    try {
      expect(() => {
        for (let version = 1; version <= 40; version += 1) {
          lsp.notify("textDocument/didChange", {
            textDocument: { uri: "file:///fixture.swift", version },
            contentChanges: [{ text: "x".repeat(256 * 1024) }]
          });
        }
      }).toThrow(/queue/i);
      expect(stdin.writableLength).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(state.killed).toBe(true);
      expect(state.fatal).toMatchObject({ code: "outbound_limit" });
    } finally {
      lsp.dispose("test complete", true);
      stdin.destroy();
    }
  });

  it("parses fragmented Content-Length frames and bounds its private stderr tail", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "fragmented");
    try {
      await expect(lsp.request("initialize", { capabilities: {} }, 1_000)).resolves.toMatchObject({
        capabilities: expect.any(Object)
      });
      await waitFor(async () => lsp.diagnosticTail.endsWith("LAST-DIAGNOSTIC"));
      expect(Buffer.byteLength(lsp.diagnosticTail, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(lsp.diagnosticTail).not.toContain("super-secret");
    } finally {
      lsp.dispose();
    }
  });

  it("answers only the two admitted server requests", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "server_requests");
    try {
      await initialize(lsp);
      await waitFor(async () => (await logEntries(paths.log))
        .filter((entry) => entry.type === "server_response").length === 5);
      const responses = (await logEntries(paths.log)).filter((entry) => entry.type === "server_response");
      expect(responses[0]).toMatchObject({ result: null });
      expect(responses[1]).toMatchObject({ result: [null, null] });
      for (const refused of responses.slice(2)) {
        expect(refused).toMatchObject({ error: { code: -32601, message: "Method not supported" } });
      }
      expect(JSON.stringify(responses)).not.toContain("approve");
    } finally {
      lsp.dispose();
    }
  });

  it("refuses a server request that its descriptor did not admit", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "server_requests", undefined, {
      workDoneProgressCreate: "null"
    });
    try {
      await initialize(lsp);
      await waitFor(async () => (await logEntries(paths.log))
        .filter((entry) => entry.type === "server_response").length === 5);
      const responses = (await logEntries(paths.log)).filter((entry) => entry.type === "server_response");
      expect(responses[0]).toMatchObject({ result: null });
      expect(responses[1]).toMatchObject({ error: { code: -32601, message: "Method not supported" } });
    } finally {
      lsp.dispose();
    }
  });

  it("cancels and rejects a feature request at its deadline", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "timeout");
    try {
      await initialize(lsp);
      await expect(lsp.request("textDocument/completion", {}, 30)).rejects.toMatchObject({
        code: "timeout"
      } satisfies Partial<LanguageServiceError>);
      await waitFor(async () => (await logEntries(paths.log)).some((entry) => entry.type === "cancel"));
    } finally {
      lsp.dispose();
    }
  });

  it("force-kills a server at the single shutdown deadline", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "ignore_shutdown");
    await initialize(lsp);
    const start = (await logEntries(paths.log)).find((entry) => entry.type === "start");
    const pid = start?.pid as number;
    expect(processAlive(pid)).toBe(true);

    await lsp.shutdown();
    await waitFor(async () => !processAlive(pid));
    expect((await logEntries(paths.log)).some((entry) => entry.type === "sigterm")).toBe(false);
  });

  it("kills a peer as soon as an advertised frame exceeds four MiB", async () => {
    const paths = await testRoot();
    let fatal: Error | undefined;
    const lsp = client(paths.root, paths.log, "oversized", (error) => { fatal = error; });
    try {
      await expect(lsp.request("initialize", {}, 1_000)).rejects.toThrow(/frame exceeded/i);
      await waitFor(async () => fatal !== undefined);
      expect(fatal).toBeInstanceOf(LanguageServiceError);
    } finally {
      lsp.dispose();
    }
  });

  it("refuses an outbound JSON-RPC frame over four MiB", async () => {
    const paths = await testRoot();
    const lsp = client(paths.root, paths.log, "normal");
    try {
      await initialize(lsp);
      await expect(lsp.request("test/oversized", { text: "x".repeat(4 * 1024 * 1024) }, 100))
        .rejects.toMatchObject({ code: "outbound_limit" } satisfies Partial<LanguageServiceError>);
    } finally {
      lsp.dispose();
    }
  });

  it("fails closed on a malformed JSON-RPC error response", async () => {
    const paths = await testRoot();
    let fatal: Error | undefined;
    const lsp = client(paths.root, paths.log, "invalid_error", (error) => { fatal = error; });
    try {
      await initialize(lsp);
      await expect(lsp.request("textDocument/completion", {}, 100))
        .rejects.toThrow(/invalid JSON-RPC error/i);
      expect(fatal?.message).toMatch(/invalid JSON-RPC error/i);
    } finally {
      lsp.dispose();
    }
  });
});
