import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LanguageServiceServerFrame } from "../src/domain/languageService";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import { LanguageServiceError } from "../src/editor/languageServices/errors";
import { LanguageServiceHost, type LanguageServiceConnectionPort } from "../src/editor/languageServices/LanguageServiceHost";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS, type LanguageServiceLimits } from "../src/editor/languageServices/limits";
import { LanguageServiceRegistry, languageServiceEnvironment, sourceKitLspDescriptor } from "../src/editor/languageServices/registry";
import type { LanguageServiceDescriptor } from "../src/editor/languageServices/types";
import type { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";

const fakeServer = resolve(__dirname, "fixtures/fakeLanguageServer.mjs");
const roots: string[] = [];
const hosts: LanguageServiceHost[] = [];

function config(root: string): ServiceConfig {
  return {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: join(root, "registered"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    languageServicesEnabled: true
  };
}

function descriptor(log: string, mode = "normal", outsidePath = ""): LanguageServiceDescriptor {
  return {
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
    resolveExecutable: async () => ({ command: process.execPath, args: [fakeServer, log, mode, outsidePath] })
  };
}

async function fixture(
  mode = "normal",
  outsidePath = "",
  limitOverrides: Partial<LanguageServiceLimits> = {}
): Promise<{
  host: LanguageServiceHost;
  workspace: LocalWorkspace;
  log: string;
  connection(id?: string): { port: LanguageServiceConnectionPort; frames: LanguageServiceServerFrame[] };
}> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-language-host-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(join(workspacePath, "Sources"), { recursive: true });
  await writeFile(join(workspacePath, "Package.swift"), "// package\n");
  await writeFile(join(workspacePath, "Sources", "main.swift"), "😀e\u0301z\n");
  const workspace: LocalWorkspace = {
    id: "workspace-1",
    name: "Fixture",
    path: workspacePath,
    kind: "user_selected",
    trustedAt: new Date(0).toISOString(),
    lastOpenedAt: new Date(0).toISOString(),
    git: { isRepository: false }
  };
  const serviceConfig = config(root);
  const log = join(root, "server.ndjson");
  const serviceDescriptor = descriptor(log, mode, outsidePath);
  const registry = new LanguageServiceRegistry(serviceConfig, [serviceDescriptor]);
  const workspaces = {
    findByIdWithoutGitRefresh: async (id: string) => id === workspace.id ? workspace : undefined
  } as unknown as LocalWorkspaceRegistry;
  const host = new LanguageServiceHost({
    config: serviceConfig,
    registry,
    workspaces,
    limits: {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      initializeTimeoutMs: 2_000,
      featureTimeoutMs: 250,
      shutdownTimeoutMs: 500,
      changeDebounceMs: 20,
      idleTimeoutMs: 100,
      ...limitOverrides
    }
  });
  hosts.push(host);
  return {
    host,
    workspace,
    log,
    connection(id = `connection-${Math.random()}`) {
      const frames: LanguageServiceServerFrame[] = [];
      return { port: { id, workspaceId: workspace.id, send: (frame) => frames.push(frame) }, frames };
    }
  };
}

async function entries(path: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(path, "utf8").catch(() => "");
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolveValue) => setTimeout(resolveValue, 10));
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

async function open(
  test: Awaited<ReturnType<typeof fixture>>,
  connection: LanguageServiceConnectionPort,
  text = "😀e\u0301z\n"
): Promise<void> {
  await test.host.openDocument(connection, {
    path: "Sources/main.swift",
    languageId: "swift",
    clientVersion: 1,
    text
  });
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("language-service host", () => {
  it("normalizes the frozen feature set and UTF-16 positions", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "agentroom-language-outside-"));
    roots.push(outsideRoot);
    const outside = join(outsideRoot, "outside.swift");
    await writeFile(outside, "x\n");
    const test = await fixture("normal", outside);
    const connection = test.connection("primary");
    await open(test, connection.port);
    await waitFor(() => connection.frames.some((frame) => frame.type === "diagnostics"));

    const completion = await test.host.requestFeature(connection.port.id, {
      requestId: "completion-1",
      clientVersion: 1,
      kind: "completion",
      position: { line: 0, character: 2 }
    });
    expect(completion).toMatchObject({
      type: "response",
      result: {
        kind: "completion",
        items: [
          { label: "value", kind: "variable", documentation: "[docs](command:bad)" },
          { label: "greet(name: string): void", kind: "function", insertText: "greet" }
        ],
        truncated: true
      }
    });
    const diagnostics = connection.frames.find((frame) => frame.type === "diagnostics");
    expect(diagnostics).toMatchObject({
      clientVersion: 1,
      diagnostics: [{ message: "<b>problem</b> `here`", severity: "warning", code: "7" }]
    });
    expect(connection.frames.find((frame) => frame.type === "status"))
      .toMatchObject({ readiness: "ready", clientVersion: 1 });

    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "hover-1", clientVersion: 1, kind: "hover", position: { line: 0, character: 4 }
    })).resolves.toMatchObject({ result: { kind: "hover", hover: { contents: "<script>x</script> **hover**" } } });
    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "definition-1", clientVersion: 1, kind: "definition", position: { line: 0, character: 2 }
    })).resolves.toMatchObject({ result: { kind: "definition", locations: [{ path: "Sources/main.swift" }], truncated: true } });
    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "symbols-1", clientVersion: 1, kind: "document_symbols"
    })).resolves.toMatchObject({ result: { kind: "document_symbols", symbols: [{ name: "Thing", kind: "struct" }] } });
    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "tokens-1", clientVersion: 1, kind: "semantic_tokens"
    })).resolves.toMatchObject({ result: { kind: "semantic_tokens", tokens: { data: [0, 0, 2, 0, 0] } } });

    const logged = await entries(test.log);
    expect(logged.find((entry) => entry.type === "request")).toMatchObject({
      position: { line: 0, character: 2 }
    });
  });

  it("coalesces full-buffer changes while preserving separate client and LSP versions", async () => {
    const test = await fixture();
    const connection = test.connection("primary");
    await open(test, connection.port);
    await test.host.changeDocument(connection.port.id, 2, "😀a\n");
    await test.host.changeDocument(connection.port.id, 3, "😀latest\n");
    await test.host.requestFeature(connection.port.id, {
      requestId: "completion-3",
      clientVersion: 3,
      kind: "completion",
      position: { line: 0, character: 2 }
    });

    const changes = (await entries(test.log)).filter((entry) => entry.type === "change");
    expect(changes).toEqual([expect.objectContaining({ version: 2, text: "😀latest\n" })]);
    await expect(test.host.changeDocument(connection.port.id, 3, "old\n"))
      .rejects.toMatchObject({ code: "resync_required" } satisfies Partial<LanguageServiceError>);
  });

  it("leases a normalized path to one socket and releases it on close", async () => {
    const test = await fixture();
    const first = test.connection("first");
    const second = test.connection("second");
    await open(test, first.port);
    await expect(open(test, second.port))
      .rejects.toMatchObject({ code: "document_busy" } satisfies Partial<LanguageServiceError>);
    await test.host.closeConnection(first.port.id);
    await expect(open(test, second.port)).resolves.toBeUndefined();
  });

  it("shares one project service across tabs in different editor panels", async () => {
    const test = await fixture();
    await writeFile(join(test.workspace.path, "Sources", "other.swift"), "let other = 2\n");
    const first = test.connection("panel-one");
    const second = test.connection("panel-two");

    await open(test, first.port);
    await test.host.openDocument(second.port, {
      path: "Sources/other.swift",
      languageId: "swift",
      clientVersion: 1,
      text: "let other = 2\n"
    });

    const log = await entries(test.log);
    expect(log.filter((entry) => entry.type === "start")).toHaveLength(1);
    expect(new Set(log.filter((entry) => entry.type === "open").map((entry) => entry.processNumber)).size).toBe(1);
  });

  it("uses distinct service instances for two project roots in one workspace", async () => {
    const test = await fixture();
    await mkdir(join(test.workspace.path, "Nested"), { recursive: true });
    await writeFile(join(test.workspace.path, "Nested", "Package.swift"), "// nested package\n");
    await writeFile(join(test.workspace.path, "Nested", "main.swift"), "let nested = 2\n");

    await open(test, test.connection("root-panel").port);
    await test.host.openDocument(test.connection("nested-panel").port, {
      path: "Nested/main.swift",
      languageId: "swift",
      clientVersion: 1,
      text: "let nested = 2\n"
    });

    const log = await entries(test.log);
    const starts = log.filter((entry) => entry.type === "start");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2);
  });

  it("reserves the per-process document cap across concurrent opens", async () => {
    const test = await fixture("delayed_initialize", "", { maxDocumentsPerProcess: 1 });
    await writeFile(join(test.workspace.path, "Sources", "other.swift"), "x\n");
    const outcomes = await Promise.allSettled([
      open(test, test.connection("first").port),
      test.host.openDocument(test.connection("second").port, {
        path: "Sources/other.swift", languageId: "swift", clientVersion: 1, text: "x\n"
      })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected"))
      .toMatchObject({ reason: { code: "document_limit" } });
  });

  it("reserves the global shadow-byte cap across concurrent opens", async () => {
    const test = await fixture("delayed_initialize", "", { maxGlobalDocumentBytes: 10 });
    await writeFile(join(test.workspace.path, "Sources", "other.swift"), "x\n");
    const outcomes = await Promise.allSettled([
      open(test, test.connection("first").port, "12345678"),
      test.host.openDocument(test.connection("second").port, {
        path: "Sources/other.swift", languageId: "swift", clientVersion: 1, text: "12345678"
      })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected"))
      .toMatchObject({ reason: { code: "global_document_limit" } });
  });

  it("cancels a pending open and releases its path lease on disconnect", async () => {
    const test = await fixture("delayed_initialize");
    const first = test.connection("first");
    const opening = open(test, first.port);
    await waitFor(async () => (await entries(test.log)).some((entry) => entry.type === "start"));
    await test.host.closeConnection(first.port.id);
    await expect(opening).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<LanguageServiceError>);
    await expect(open(test, test.connection("second").port)).resolves.toBeUndefined();
  });

  it("releases a disconnected shadow exactly once when close paths race", async () => {
    const test = await fixture("normal", "", { maxGlobalDocumentBytes: 10 });
    await writeFile(join(test.workspace.path, "Sources", "second.swift"), "x\n");
    await writeFile(join(test.workspace.path, "Sources", "third.swift"), "x\n");
    const first = test.connection("first");
    await open(test, first.port, "12345678");
    await Promise.all([
      test.host.closeConnection(first.port.id),
      test.host.closeConnection(first.port.id)
    ]);

    const second = test.connection("second");
    await test.host.openDocument(second.port, {
      path: "Sources/second.swift", languageId: "swift", clientVersion: 1, text: "12345678"
    });
    const third = test.connection("third");
    await expect(test.host.openDocument(third.port, {
      path: "Sources/third.swift", languageId: "swift", clientVersion: 1, text: "12345678"
    })).rejects.toMatchObject({ code: "global_document_limit" } satisfies Partial<LanguageServiceError>);
  });

  it("restarts within budget and replays the latest unsaved shadow with a new LSP version", async () => {
    const test = await fixture("crash_once");
    const connection = test.connection("primary");
    await open(test, connection.port, "initial\n");
    await test.host.changeDocument(connection.port.id, 2, "unsaved draft\n");

    await waitFor(async () => (await entries(test.log)).filter((entry) => entry.type === "open").length >= 2);
    const opens = (await entries(test.log)).filter((entry) => entry.type === "open");
    expect(opens[1]).toMatchObject({
      processNumber: 2,
      document: { version: 3, text: "unsaved draft\n" }
    });
    expect(connection.frames.filter((frame) => frame.type === "status").map((frame) => frame.readiness))
      .toEqual(expect.arrayContaining(["ready", "restarting"]));
  });

  it("keeps replay pending when replacement initialization fails", async () => {
    const test = await fixture("restart_init_fail_once");
    const connection = test.connection("replay-retry");
    await open(test, connection.port, "initial\n");
    await test.host.changeDocument(connection.port.id, 2, "crash\n");
    await waitFor(() => connection.frames.some(
      (frame) => frame.type === "status" && frame.readiness === "failed"
    ));

    await test.host.changeDocument(connection.port.id, 3, "latest draft\n");
    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "after-restart", clientVersion: 3, kind: "completion", position: { line: 0, character: 1 }
    })).resolves.toMatchObject({ type: "response", clientVersion: 3 });

    const thirdProcess = (await entries(test.log)).filter((entry) => entry.processNumber === 3);
    expect(thirdProcess.find((entry) => entry.type === "open"))
      .toMatchObject({ document: { text: "latest draft\n" } });
    expect(thirdProcess.findIndex((entry) => entry.type === "open"))
      .toBeLessThan(thirdProcess.findIndex((entry) => entry.type === "request"));
  });

  it("forwards cancellation but discards the cancelled response path", async () => {
    const test = await fixture("timeout");
    const connection = test.connection("primary");
    await open(test, connection.port);
    const response = test.host.requestFeature(connection.port.id, {
      requestId: "cancel-me",
      clientVersion: 1,
      kind: "completion",
      position: { line: 0, character: 2 }
    });
    await waitFor(async () => (await entries(test.log)).some((entry) => entry.type === "request"));
    test.host.cancelRequest(connection.port.id, "cancel-me");
    await expect(response).resolves.toBeUndefined();
    expect((await entries(test.log)).some((entry) => entry.type === "cancel")).toBe(true);
  });

  it("passes only descriptor-allowlisted environment keys", () => {
    const environment = languageServiceEnvironment(sourceKitLspDescriptor, {
      PATH: "/bin",
      HOME: "/tmp/home",
      AUTH_TOKEN: "transport-secret",
      OPENAI_API_KEY: "provider-secret",
      ANTHROPIC_API_KEY: "provider-secret"
    });
    expect(environment).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
  });

  it("enforces per-process document and per-workspace process caps", async () => {
    const documentTest = await fixture("normal", "", { maxDocumentsPerProcess: 1 });
    await writeFile(join(documentTest.workspace.path, "Sources", "other.swift"), "x\n");
    const first = documentTest.connection("first");
    const second = documentTest.connection("second");
    await open(documentTest, first.port);
    await expect(documentTest.host.openDocument(second.port, {
      path: "Sources/other.swift", languageId: "swift", clientVersion: 1, text: "x\n"
    })).rejects.toMatchObject({ code: "document_limit" } satisfies Partial<LanguageServiceError>);

    const processTest = await fixture("normal", "", { maxProcesses: 1, maxProcessesPerWorkspace: 1 });
    await mkdir(join(processTest.workspace.path, "Nested"), { recursive: true });
    await writeFile(join(processTest.workspace.path, "Nested", "Package.swift"), "// nested\n");
    await writeFile(join(processTest.workspace.path, "Nested", "main.swift"), "x\n");
    const rootConnection = processTest.connection("root");
    const nestedConnection = processTest.connection("nested");
    await open(processTest, rootConnection.port);
    await expect(processTest.host.openDocument(nestedConnection.port, {
      path: "Nested/main.swift", languageId: "swift", clientVersion: 1, text: "x\n"
    })).rejects.toMatchObject({ code: "process_limit" } satisfies Partial<LanguageServiceError>);
  });

  it("enforces the global shadow-byte and outstanding-request caps", async () => {
    const shadowTest = await fixture("normal", "", { maxGlobalDocumentBytes: 10 });
    await writeFile(join(shadowTest.workspace.path, "Sources", "other.swift"), "x\n");
    const first = shadowTest.connection("first");
    const second = shadowTest.connection("second");
    await open(shadowTest, first.port, "12345678");
    await expect(shadowTest.host.openDocument(second.port, {
      path: "Sources/other.swift", languageId: "swift", clientVersion: 1, text: "123"
    })).rejects.toMatchObject({ code: "global_document_limit" } satisfies Partial<LanguageServiceError>);

    const requestTest = await fixture("timeout", "", { maxOutstandingPerSocket: 1 });
    const connection = requestTest.connection("requests");
    await open(requestTest, connection.port);
    const firstRequest = requestTest.host.requestFeature(connection.port.id, {
      requestId: "one", clientVersion: 1, kind: "completion", position: { line: 0, character: 2 }
    });
    await waitFor(async () => (await entries(requestTest.log)).some((entry) => entry.type === "request"));
    await expect(requestTest.host.requestFeature(connection.port.id, {
      requestId: "two", clientVersion: 1, kind: "completion", position: { line: 0, character: 2 }
    })).rejects.toMatchObject({ code: "request_limit" } satisfies Partial<LanguageServiceError>);
    requestTest.host.cancelRequest(connection.port.id, "one");
    await firstRequest;
  });

  it("closes an idle child and completes the graceful shutdown path", async () => {
    const test = await fixture();
    const connection = test.connection("idle");
    await open(test, connection.port);
    await test.host.closeConnection(connection.port.id);
    await waitFor(async () => (await entries(test.log)).some((entry) => entry.type === "exit"));
    expect((await entries(test.log)).some((entry) => entry.type === "shutdown")).toBe(true);
  });

  it("force-kills language servers during backend shutdown", async () => {
    const test = await fixture("ignore_shutdown", "", { shutdownTimeoutMs: 1_000 });
    const connection = test.connection("shutdown");
    await open(test, connection.port);
    const start = (await entries(test.log)).find((entry) => entry.type === "start");
    const pid = start?.pid as number;
    expect(processAlive(pid)).toBe(true);

    const startedAt = Date.now();
    await test.host.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await waitFor(() => !processAlive(pid));
  });

  it("marks a service failed after its fourth crash inside the restart window", async () => {
    const test = await fixture("crash_loop");
    const connection = test.connection("crash-loop");
    await open(test, connection.port);
    await waitFor(() => connection.frames.some(
      (frame) => frame.type === "status" && frame.readiness === "failed"
    ), 4_000);
    expect((await entries(test.log)).filter((entry) => entry.type === "start")).toHaveLength(4);
    await test.host.changeDocument(connection.port.id, 2, "edited after failure");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(test.host.requestFeature(connection.port.id, {
      requestId: "after-failure", clientVersion: 2, kind: "hover", position: { line: 0, character: 0 }
    })).rejects.toMatchObject({ code: "service_unavailable" });
    expect((await entries(test.log)).filter((entry) => entry.type === "start")).toHaveLength(4);
  });

  it("shares a lease and version sequence between case aliases of one file", async (context) => {
    const test = await fixture();
    const alias = "sources/MAIN.swift";
    const canonical = await realpath(join(test.workspace.path, "Sources/main.swift"));
    if (await realpath(join(test.workspace.path, alias)).catch(() => undefined) !== canonical) {
      context.skip();
      return;
    }
    const first = test.connection("first-case");
    const second = test.connection("second-case");
    await open(test, first.port);
    const input = { path: alias, languageId: "swift", clientVersion: 1, text: "other draft" };
    await expect(test.host.openDocument(second.port, input)).rejects.toMatchObject({ code: "document_busy" });
    await test.host.closeConnection(first.port.id);
    await test.host.openDocument(second.port, input);
    await waitFor(async () => (await entries(test.log)).filter((entry) => entry.type === "open").length === 2);
    const opened = (await entries(test.log)).filter((entry) => entry.type === "open");
    const firstDocument = opened[0].document as { version: number; uri: string };
    const secondDocument = opened[1].document as { version: number; uri: string };
    expect(secondDocument.version).toBeGreaterThan(firstDocument.version);
    expect(secondDocument.uri).toBe(firstDocument.uri);
  });

  it("refuses a server that selects a non-UTF-16 coordinate system", async () => {
    const test = await fixture("utf8");
    const connection = test.connection("utf8");
    await expect(open(test, connection.port))
      .rejects.toMatchObject({ code: "unsupported_response" } satisfies Partial<LanguageServiceError>);
  });
});
