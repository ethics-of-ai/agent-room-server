import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  LanguageServiceRegistry,
  pyrightLanguageServerDescriptor,
  sourceKitLspDescriptor,
  typeScriptLanguageServerDescriptor
} from "../src/editor/languageServices/registry";

const roots: string[] = [];

function config(root: string, executable?: string): ServiceConfig {
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
    languageServicesEnabled: true,
    ...(executable ? { sourcekitLspExecutable: executable } : {})
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("language-service registry", () => {
  it("owns SourceKit-LSP's fixed server-request allowlist", () => {
    expect(sourceKitLspDescriptor.serverRequests).toEqual({ workDoneProgressCreate: "null" });
  });

  it("owns the TypeScript server's tested contract and fixed bundled launch", async () => {
    expect(typeScriptLanguageServerDescriptor).toMatchObject({
      testedVersion: "typescript-language-server 5.3.0; TypeScript 5.9.3",
      positionEncoding: "utf-16",
      languageIds: ["typescript", "typescriptreact", "javascript"],
      standaloneWorkspaceRoot: true,
      projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: true },
      serverRequests: {
        workDoneProgressCreate: "null",
        workspaceConfiguration: "null_per_item"
      }
    });
    expect(typeScriptLanguageServerDescriptor.projectMarkers).toEqual([
      { kind: "exact", value: "tsconfig.json", priority: 120, entryType: "file" },
      { kind: "exact", value: "jsconfig.json", priority: 120, entryType: "file" },
      { kind: "exact", value: "package.json", priority: 100, entryType: "file" }
    ]);

    const launch = await typeScriptLanguageServerDescriptor.resolveExecutable(config("/tmp"));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[1]).toBe("--stdio");
    expect(isAbsolute(launch.args[0])).toBe(true);
    expect((await lstat(launch.args[0])).isFile()).toBe(true);
    const initializationOptions = launch.initializationOptions as {
      disableAutomaticTypingAcquisition: boolean;
      tsserver: { path: string };
    };
    expect(initializationOptions.disableAutomaticTypingAcquisition).toBe(true);
    const tsserver = initializationOptions.tsserver.path;
    expect(isAbsolute(tsserver)).toBe(true);
    expect((await lstat(tsserver)).isFile()).toBe(true);
  });

  it("owns Pyright's tested contract and fixed bundled launch", async () => {
    expect(pyrightLanguageServerDescriptor).toMatchObject({
      testedVersion: "Pyright 1.1.413",
      positionEncoding: "utf-16",
      languageIds: ["python"],
      featureKinds: ["completion", "hover", "definition", "document_symbols"],
      standaloneWorkspaceRoot: true,
      projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: false },
      serverRequests: {
        workDoneProgressCreate: "null",
        workspaceConfiguration: "null_per_item"
      }
    });
    expect(pyrightLanguageServerDescriptor.projectMarkers).toEqual([
      { kind: "exact", value: "pyrightconfig.json", priority: 130, entryType: "file" },
      { kind: "exact", value: "pyproject.toml", priority: 120, entryType: "file" },
      { kind: "exact", value: "manage.py", priority: 100, entryType: "file" }
    ]);

    const launch = await pyrightLanguageServerDescriptor.resolveExecutable(config("/tmp"));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[1]).toBe("--stdio");
    expect(isAbsolute(launch.args[0])).toBe(true);
    expect((await lstat(launch.args[0])).isFile()).toBe(true);
  });

  it("admits only an absolute executable regular file, never a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-language-registry-"));
    roots.push(root);
    const executable = join(root, "sourcekit-lsp");
    const alias = join(root, "sourcekit-alias");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    await symlink(executable, alias);

    await expect(sourceKitLspDescriptor.resolveExecutable(config(root, executable)))
      .resolves.toEqual({ command: await realpath(executable), args: [] });
    await expect(sourceKitLspDescriptor.resolveExecutable(config(root, alias)))
      .rejects.toMatchObject({ code: "service_unavailable" });
    await expect(sourceKitLspDescriptor.resolveExecutable(config(root, "sourcekit-lsp")))
      .rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("adds observed readiness without projecting descriptor execution details", () => {
    const root = "/tmp/agentroom-language-registry";
    const registry = new LanguageServiceRegistry(config(root), [sourceKitLspDescriptor]);
    expect(registry.projection()[0]).not.toHaveProperty("ready");
    registry.observe(sourceKitLspDescriptor.id, false);
    const projection = registry.projection()[0];
    expect(projection.ready).toBe(false);
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain("environmentKeys");
    expect(encoded).not.toContain("projectMarkers");
    expect(encoded).not.toContain("xcrun");
  });

  it("publishes every built-in service without private descriptor metadata", () => {
    const projection = new LanguageServiceRegistry(config("/tmp")).projection();
    expect(projection.map((service) => service.id)).toEqual([
      "sourcekit_lsp",
      "typescript_language_server",
      "pyright_language_server",
      "rust_analyzer",
      "gopls",
      "eclipse_jdt_ls",
      "kotlin_lsp",
      "csharp_ls"
    ]);
    expect(projection[1]).toMatchObject({
      configured: true,
      enabled: true,
      languageIds: ["typescript", "typescriptreact", "javascript"]
    });
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain("testedVersion");
    expect(encoded).not.toContain("tsserver");
    expect(encoded).not.toContain("projectMarkers");
    expect(encoded).not.toContain("temporaryStorage");
    expect(encoded).not.toContain("-data");
    expect(projection[2]).toMatchObject({
      configured: true,
      enabled: true,
      languageIds: ["python"],
      featureKinds: ["completion", "hover", "definition", "document_symbols"]
    });
    expect(projection.slice(3)).toMatchObject([
      { id: "rust_analyzer", configured: false, languageIds: ["rust"] },
      { id: "gopls", configured: false, languageIds: ["go"] },
      { id: "eclipse_jdt_ls", configured: false, languageIds: ["java"] },
      { id: "kotlin_lsp", configured: false, languageIds: ["kotlin"] },
      { id: "csharp_ls", configured: false, languageIds: ["csharp"] }
    ]);
  });
});
