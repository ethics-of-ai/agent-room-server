import { pathToFileURL } from "node:url";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import {
  externalLanguageServiceDescriptor,
  externalLanguageServiceDescriptors,
  readExternalLanguageServiceAdapterConfigs
} from "../src/editor/languageServices/externalAdapters";
import { LspEditorLanguageService } from "../src/editor/languageServices/LspEditorLanguageService";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "../src/editor/languageServices/limits";
import { resolveLanguageServiceProject } from "../src/editor/languageServices/projectRoot";
import {
  builtInLanguageServiceDescriptors,
  configuredLanguageServiceDescriptors,
  languageServiceEnvironment,
  LanguageServiceRegistry
} from "../src/editor/languageServices/registry";

const roots: string[] = [];
const fakeLanguageServer = resolve(__dirname, "fixtures", "fakeLanguageServer.mjs");

function config(root: string): ServiceConfig {
  return {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    languageServicesEnabled: true
  };
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "external_lsp_fixture",
    displayName: "Fixture Language Server",
    testedVersion: "fixture 1.0",
    command: process.execPath,
    args: [],
    languageIds: ["fixturelang"],
    projectMarkers: [
      { kind: "exact", value: "fixture.project", priority: 100, entryType: "file" }
    ],
    standaloneWorkspaceRoot: true,
    featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
    envGrants: ["FIXTURE_LANGUAGE_HOME"],
    ...overrides
  };
}

function readDefinitions(value: unknown): ReturnType<typeof readExternalLanguageServiceAdapterConfigs> {
  process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED = "true";
  return readExternalLanguageServiceAdapterConfigs(JSON.stringify(value));
}

afterEach(async () => {
  delete process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED;
  delete process.env.LANGUAGE_SERVICE_ADAPTERS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external language-service adapter configuration", () => {
  it("is absent by default even when definitions are present", () => {
    process.env.LANGUAGE_SERVICE_ADAPTERS = JSON.stringify([definition()]);
    expect(readExternalLanguageServiceAdapterConfigs()).toEqual([]);
  });

  it("drops a malformed definition list whole", () => {
    process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED = "true";
    expect(readExternalLanguageServiceAdapterConfigs("{not json")).toEqual([]);
    expect(readDefinitions([
      definition(),
      definition({ id: "not_namespaced", languageIds: ["otherlang"] })
    ])).toEqual([]);
  });

  it("bounds the raw document and rejects unknown fields and broad suffix markers", () => {
    process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED = "true";
    expect(readExternalLanguageServiceAdapterConfigs(" ".repeat(64 * 1_024 + 1))).toEqual([]);
    expect(readDefinitions([definition({ unexpected: true })])).toEqual([]);
    expect(readDefinitions([definition({
      projectMarkers: [{ kind: "suffix", value: "project", priority: 100, entryType: "file" }]
    })])).toEqual([]);
  });

  it("requires deterministic unique ids, languages, features, markers, and environment grants", () => {
    expect(readDefinitions([
      definition(),
      definition({ id: "external_lsp_other" })
    ])).toEqual([]);
    expect(readDefinitions([definition({ languageIds: ["fixturelang", "fixturelang"] })])).toEqual([]);
    expect(readDefinitions([definition({ featureKinds: ["hover", "hover"] })])).toEqual([]);
    expect(readDefinitions([definition({
      projectMarkers: [
        { kind: "exact", value: "fixture.project", priority: 100, entryType: "file" },
        { kind: "exact", value: "fixture.project", priority: 90, entryType: "file" }
      ]
    })])).toEqual([]);
    expect(readDefinitions([definition({ envGrants: ["FIXTURE_HOME", "FIXTURE_HOME"] })])).toEqual([]);
  });

  it("refuses relative commands, credential grants, and markerless project-only services", () => {
    expect(readDefinitions([definition({ command: "bin/language-server" })])).toEqual([]);
    expect(readDefinitions([definition({ envGrants: ["OPENAI_API_KEY"] })])).toEqual([]);
    expect(readDefinitions([definition({ standaloneWorkspaceRoot: false, projectMarkers: [] })])).toEqual([]);
  });

  it("drops every external adapter when one would shadow a built-in language", () => {
    const configs = readDefinitions([
      definition(),
      definition({ id: "external_lsp_swift", languageIds: ["swift"] })
    ]);
    expect(externalLanguageServiceDescriptors(configs, new Set(["swift"]))).toEqual([]);
  });

  it("assembles accepted external descriptors after the built-in registry", () => {
    process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED = "true";
    process.env.LANGUAGE_SERVICE_ADAPTERS = JSON.stringify([definition()]);
    expect(configuredLanguageServiceDescriptors().map((descriptor) => descriptor.id)).toEqual([
      ...builtInLanguageServiceDescriptors.map((descriptor) => descriptor.id),
      "external_lsp_fixture"
    ]);

    process.env.LANGUAGE_SERVICE_ADAPTERS = JSON.stringify([definition({ languageIds: ["swift"] })]);
    expect(configuredLanguageServiceDescriptors()).toEqual(builtInLanguageServiceDescriptors);
  });

  it("builds a conservative descriptor and a safe public projection", async () => {
    const [adapter] = readDefinitions([definition()]);
    const descriptor = externalLanguageServiceDescriptor(adapter);
    expect(descriptor).toMatchObject({
      id: "external_lsp_fixture",
      testedVersion: "fixture 1.0",
      positionEncoding: "utf-16",
      languageIds: ["fixturelang"],
      standaloneWorkspaceRoot: true,
      projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
      serverRequests: {
        workDoneProgressCreate: "null",
        workspaceConfiguration: "null_per_item"
      }
    });
    expect(descriptor.configured(config("/tmp"))).toBe(true);
    await expect(descriptor.resolveExecutable(config("/tmp"))).resolves.toEqual({
      command: process.execPath,
      args: []
    });

    const projection = new LanguageServiceRegistry(config("/tmp"), [descriptor]).projection()[0];
    expect(projection).toMatchObject({
      id: "external_lsp_fixture",
      configured: true,
      enabled: true,
      languageIds: ["fixturelang"]
    });
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain(process.execPath);
    expect(encoded).not.toContain("fixture.project");
    expect(encoded).not.toContain("FIXTURE_LANGUAGE_HOME");
    expect(encoded).not.toContain("testedVersion");
  });

  it("registers the safe projection without spawning the configured process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-external-lsp-route-"));
    roots.push(root);
    const logPath = join(root, "server.ndjson");
    process.env.EXTERNAL_LANGUAGE_SERVICES_ENABLED = "true";
    process.env.LANGUAGE_SERVICE_ADAPTERS = JSON.stringify([
      definition({ args: [fakeLanguageServer, logPath, "normal"] })
    ]);
    const server = await buildServer({ config: config(root) });
    try {
      const response = await server.app.inject({ method: "GET", url: "/api/editor/language-services" });
      expect(response.statusCode).toBe(200);
      const external = response.json().services.find(
        (service: { id: string }) => service.id === "external_lsp_fixture"
      );
      expect(external).toMatchObject({
        configured: true,
        enabled: true,
        languageIds: ["fixturelang"]
      });
      expect(response.body).not.toContain(process.execPath);
      await expect(lstat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.app.close();
    }
  });

  it("admits an executable regular file and refuses a symlink at launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-external-lsp-admission-"));
    roots.push(root);
    const executable = join(root, "language-server");
    const alias = join(root, "language-server-link");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    await symlink(executable, alias);

    const [admitted] = readDefinitions([definition({ command: executable })]);
    const admittedDescriptor = externalLanguageServiceDescriptor(admitted);
    expect(admittedDescriptor.configured(config(root))).toBe(true);

    const [linked] = readDefinitions([definition({ command: alias })]);
    const linkedDescriptor = externalLanguageServiceDescriptor(linked);
    expect(linkedDescriptor.configured(config(root))).toBe(true);
    await expect(linkedDescriptor.resolveExecutable(config(root)))
      .rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("passes only the base environment and explicit non-credential grants", () => {
    const [adapter] = readDefinitions([definition()]);
    const descriptor = externalLanguageServiceDescriptor(adapter);
    const environment = languageServiceEnvironment(descriptor, {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      FIXTURE_LANGUAGE_HOME: "/opt/fixture",
      AUTH_TOKEN: "agentroom-secret",
      OPENAI_API_KEY: "provider-secret",
      UNRELATED_VALUE: "not granted"
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      FIXTURE_LANGUAGE_HOME: "/opt/fixture"
    });
  });

  it("uses configured project markers through the shared bounded resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-external-lsp-project-"));
    roots.push(root);
    await mkdir(join(root, "package", "src"), { recursive: true });
    await writeFile(join(root, "package", "fixture.project"), "project\n");
    await writeFile(join(root, "package", "src", "main.fixture"), "ok\n");
    const workspace: LocalWorkspace = {
      id: "workspace-external-lsp",
      name: "External LSP fixture",
      path: root,
      kind: "user_selected",
      trustedAt: new Date(0).toISOString(),
      lastOpenedAt: new Date(0).toISOString(),
      git: { isRepository: false }
    };
    const [adapter] = readDefinitions([definition()]);
    await expect(resolveLanguageServiceProject(
      workspace,
      "package/src/main.fixture",
      "fixturelang",
      [externalLanguageServiceDescriptor(adapter)]
    )).resolves.toMatchObject({
      relativeProjectRoot: "package",
      marker: "fixture.project"
    });
  });

  it("runs the generic bounded LSP adapter without a protocol-specific branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-external-lsp-conformance-"));
    roots.push(root);
    const logPath = join(root, "server.ndjson");
    const documentPath = join(root, "fixture.lang");
    await writeFile(documentPath, "ok\n");
    const [adapter] = readDefinitions([definition({
      args: [fakeLanguageServer, logPath, "normal"]
    })]);
    const service = new LspEditorLanguageService({
      descriptor: externalLanguageServiceDescriptor(adapter),
      config: config(root),
      projectRoot: root,
      projectName: "External LSP conformance",
      limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, initializeTimeoutMs: 1_000, shutdownTimeoutMs: 500 },
      onNotification: () => undefined,
      onFatal: () => undefined
    });
    try {
      await expect(service.probe()).resolves.toBe("ready");
      const uri = pathToFileURL(documentPath).toString();
      await service.openDocument({
        documentId: "document-1",
        uri,
        languageId: "fixturelang",
        lspVersion: 1,
        text: "ok\n"
      });
      for (const kind of [
        "completion",
        "hover",
        "definition",
        "document_symbols",
        "semantic_tokens"
      ] as const) {
        const response = service.request({
          kind,
          uri,
          ...(kind === "completion" || kind === "hover" || kind === "definition"
            ? { position: { line: 0, character: 1 } }
            : {}),
          timeoutMs: 1_000
        });
        await expect(response.promise).resolves.toBeDefined();
      }
    } finally {
      await service.close({ force: true });
    }
  });
});
