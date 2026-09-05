import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageServiceServerFrame } from "../src/domain/languageService";
import type { ServiceConfig } from "../src/domain/models";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS, type LanguageServiceLimits } from "../src/editor/languageServices/limits";
import type { LanguageServiceDescriptor } from "../src/editor/languageServices/types";
import { BoundedLanguageServiceSender } from "../src/routes/languageServiceRoutes";
import { buildServer } from "../src/server";

const fakeServer = resolve(__dirname, "fixtures/fakeLanguageServer.mjs");
const roots: string[] = [];

async function setup(
  enabled: boolean,
  requireAuth = false,
  mode = "normal",
  limitOverrides: Partial<LanguageServiceLimits> = {}
): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>["app"];
  workspaceId: string;
  log: string;
  descriptor: LanguageServiceDescriptor;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-language-routes-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "Sources"), { recursive: true });
  await writeFile(join(workspace, "Package.swift"), "// package\n");
  await writeFile(join(workspace, "Sources", "main.swift"), "let value = 1\n");
  const log = join(root, "server.ndjson");
  const descriptor: LanguageServiceDescriptor = {
    id: "fake_lsp",
    displayName: "Fake LSP",
    testedVersion: "fixture",
    positionEncoding: "utf-16",
    languageIds: ["swift"],
    featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
    projectMarkers: [{ kind: "exact", value: "Package.swift", priority: 100 }],
    standaloneWorkspaceRoot: false,
    projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: false },
    environmentKeys: ["PATH"],
    configured: () => true,
    resolveExecutable: vi.fn(async () => ({ command: process.execPath, args: [fakeServer, log, mode] }))
  };
  const config: ServiceConfig = {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: join(root, "registered"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog"),
    requireAuth,
    ...(requireAuth ? { authToken: "test-token" } : {}),
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    languageCatalogEnabled: false,
    languageServicesEnabled: enabled
  };
  const built = await buildServer({
    config,
    languageServices: {
      descriptors: [descriptor],
      limits: {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        initializeTimeoutMs: 2_000,
        featureTimeoutMs: 500,
        shutdownTimeoutMs: 500,
        changeDebounceMs: 10,
        idleTimeoutMs: 100,
        ...limitOverrides
      }
    }
  });
  await built.app.ready();
  const response = await built.app.inject({
    method: "POST",
    url: "/api/workspaces",
    ...(requireAuth ? { headers: { authorization: "Bearer test-token" } } : {}),
    payload: { path: workspace }
  });
  expect(response.statusCode).toBe(201);
  const workspaceId = (response.json() as { workspace: { id: string } }).workspace.id;
  return { app: built.app, workspaceId, log, descriptor };
}

async function logEntries(path: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(path, "utf8").catch(() => "");
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolveValue) => setTimeout(resolveValue, 10));
  }
}

function collector(): {
  options: { onInit(socket: { on(event: "message", listener: (data: unknown) => void): void }): void };
  next(): Promise<LanguageServiceServerFrame>;
} {
  const messages: LanguageServiceServerFrame[] = [];
  const waiters: Array<(frame: LanguageServiceServerFrame) => void> = [];
  return {
    options: {
      onInit(socket) {
        socket.on("message", (data) => {
          const source = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          const frame = JSON.parse(source) as LanguageServiceServerFrame;
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
          else messages.push(frame);
        });
      }
    },
    next: async () => messages.shift() ?? new Promise((resolveValue) => waiters.push(resolveValue))
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("editor language-service routes", () => {
  it("always serves a probe-free, non-secret registry projection", async () => {
    const test = await setup(false);
    try {
      const response = await test.app.inject({ method: "GET", url: "/api/editor/language-services" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        protocolVersion: 1,
        services: [{
          id: "fake_lsp",
          displayName: "Fake LSP",
          configured: true,
          enabled: false,
          languageIds: ["swift"],
          featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
        }]
      });
      expect(test.descriptor.resolveExecutable).not.toHaveBeenCalled();
      expect(JSON.stringify(response.json())).not.toContain(test.log);
      await expect(test.app.injectWS(`/api/workspaces/${test.workspaceId}/editor/language-service`))
        .rejects.toThrow(/unexpected server response: 404/i);
    } finally {
      await test.app.close();
    }
  });

  it("authenticates the enabled socket before any child can start", async () => {
    const test = await setup(true, true);
    try {
      const socket = await test.app.injectWS(
        `/api/workspaces/${test.workspaceId}/editor/language-service`
      );
      await new Promise<void>((resolveValue) => socket.on("close", () => resolveValue()));
      await expect(access(test.log)).rejects.toThrow();
      expect(test.descriptor.resolveExecutable).not.toHaveBeenCalled();
    } finally {
      await test.app.close();
    }
  });

  it("opens a bounded document and exposes only named feature requests", async () => {
    const test = await setup(true);
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "let value = 1\n"
      }));
      expect(await messages.next()).toMatchObject({
        type: "status", readiness: "ready", protocolVersion: 1, clientVersion: 1
      });
      expect(await messages.next()).toMatchObject({ type: "diagnostics", clientVersion: 1 });
      socket.send(JSON.stringify({
        type: "request",
        requestId: "completion-1",
        clientVersion: 1,
        kind: "completion",
        position: { line: 0, character: 3 }
      }));
      expect(await messages.next()).toMatchObject({
        type: "response",
        requestId: "completion-1",
        result: { kind: "completion", items: [{ label: "value" }, { label: "greet(name: string): void", insertText: "greet" }] }
      });
      const status = await test.app.inject({ method: "GET", url: "/api/editor/language-services" });
      expect(status.json()).toMatchObject({ services: [{ ready: true }] });

      socket.send(JSON.stringify({ type: "request", requestId: "raw", clientVersion: 1, kind: "workspace/executeCommand" }));
      await new Promise<void>((resolveValue) => socket.on("close", () => resolveValue()));
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("registers a request before processing its immediate cancellation", async () => {
    const test = await setup(true, false, "timeout");
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "let value = 1\n"
      }));
      await messages.next();
      await messages.next();
      socket.send(JSON.stringify({
        type: "request",
        requestId: "cancel-now",
        clientVersion: 1,
        kind: "completion",
        position: { line: 0, character: 3 }
      }));
      socket.send(JSON.stringify({ type: "cancel", requestId: "cancel-now" }));
      await waitFor(async () => (await logEntries(test.log)).some((entry) => entry.type === "cancel"));
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("bounds queued client operations and releases a pending open after disconnect", async () => {
    const test = await setup(true, false, "delayed_initialize", { maxQueuedClientFrames: 2 });
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      const closed = new Promise<void>((resolveValue) => socket.on("close", () => resolveValue()));
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "let value = 1\n"
      }));
      await waitFor(async () => (await logEntries(test.log)).some((entry) => entry.type === "start"));
      socket.send(JSON.stringify({ type: "change", clientVersion: 2, text: "let value = 2\n" }));
      socket.send(JSON.stringify({ type: "change", clientVersion: 3, text: "let value = 3\n" }));
      expect(await messages.next()).toMatchObject({ type: "error", code: "resync_required" });
      await closed;
      await waitFor(async () => (await logEntries(test.log)).some((entry) => entry.type === "initialized"));
      expect((await logEntries(test.log)).some((entry) => entry.type === "open")).toBe(false);

      const retryMessages = collector();
      const retry = await test.app.injectWS(
        `/api/workspaces/${test.workspaceId}/editor/language-service`,
        {},
        retryMessages.options
      );
      retry.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 4,
        text: "let value = 4\n"
      }));
      expect(await retryMessages.next()).toMatchObject({
        type: "status", readiness: "ready", clientVersion: 4
      });
      retry.terminate();
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("bounds queued client operations by retained bytes", async () => {
    const test = await setup(true, false, "delayed_initialize", {
      maxQueuedClientFrames: 8,
      maxQueuedClientBytes: 400
    });
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "let value = 1\n"
      }));
      await waitFor(async () => (await logEntries(test.log)).some((entry) => entry.type === "start"));
      socket.send(JSON.stringify({ type: "change", clientVersion: 2, text: "x".repeat(256) }));
      expect(await messages.next()).toMatchObject({ type: "error", code: "resync_required" });
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("rejects a document over 256 KiB without passing it to the language server", async () => {
    const test = await setup(true);
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "x".repeat(256 * 1024 + 1)
      }));
      expect(await messages.next()).toMatchObject({ type: "error", code: "document_too_large" });
      expect(test.descriptor.resolveExecutable).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("closes on the raw inbound-frame ceiling before parsing an oversized envelope", async () => {
    const test = await setup(true);
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      const closed = new Promise<void>((resolveValue) => socket.on("close", () => resolveValue()));
      socket.send(JSON.stringify({ type: "close", padding: "x".repeat(384 * 1024) }));
      expect(await messages.next()).toMatchObject({ type: "error", code: "frame_too_large" });
      await closed;
      expect(test.descriptor.resolveExecutable).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("closes with resync_required after a non-monotonic document version", async () => {
    const test = await setup(true);
    const messages = collector();
    const socket = await test.app.injectWS(
      `/api/workspaces/${test.workspaceId}/editor/language-service`,
      {},
      messages.options
    );
    try {
      const closed = new Promise<void>((resolveValue) => socket.on("close", () => resolveValue()));
      socket.send(JSON.stringify({
        type: "open",
        path: "Sources/main.swift",
        languageId: "swift",
        clientVersion: 1,
        text: "let value = 1\n"
      }));
      await messages.next();
      await messages.next();
      socket.send(JSON.stringify({ type: "change", clientVersion: 1, text: "let value = 2\n" }));
      expect(await messages.next()).toMatchObject({ type: "error", code: "resync_required" });
      await closed;
    } finally {
      socket.terminate();
      await test.app.close();
    }
  });

  it("bounds a stalled socket's outbound frame and pending queue", () => {
    const callbacks: Array<(error?: Error) => void> = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((_data: string, callback?: (error?: Error) => void) => {
        if (callback) callbacks.push(callback);
      }),
      close: vi.fn(),
      on: vi.fn()
    };
    const failed = vi.fn();
    const sender = new BoundedLanguageServiceSender(socket, {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxQueuedSocketFrames: 2,
      maxQueuedSocketBytes: 1_024
    }, failed);
    sender.send({ type: "error", code: "server_failed", message: "one" });
    sender.send({ type: "error", code: "server_failed", message: "two" });
    sender.send({ type: "error", code: "server_failed", message: "three" });
    sender.send({ type: "error", code: "server_failed", message: "four" });
    expect(socket.close).toHaveBeenCalledWith(1011, "Outbound queue limit reached");
    expect(failed).toHaveBeenCalledOnce();

    const oversized = new BoundedLanguageServiceSender(socket, {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxOutboundSocketFrameBytes: 10
    }, failed);
    oversized.send({ type: "error", code: "server_failed", message: "too large" });
    expect(socket.close).toHaveBeenCalledWith(1011, "Outbound frame too large");
  });
});
