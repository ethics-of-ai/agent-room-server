import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import { LspEditorLanguageService } from "../src/editor/languageServices/LspEditorLanguageService";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "../src/editor/languageServices/limits";
import {
  csharpLsDescriptor,
  eclipseJdtLsDescriptor,
  goplsDescriptor,
  LanguageServiceRegistry,
  kotlinLspDescriptor,
  rustAnalyzerDescriptor
} from "../src/editor/languageServices/registry";
import { prepareLanguageServiceLaunch } from "../src/editor/languageServices/launch";
import { resolveLanguageServiceProject } from "../src/editor/languageServices/projectRoot";
import type {
  LanguageServiceDescriptor,
  LanguageServiceSpawner
} from "../src/editor/languageServices/types";

type ExecutableConfigKey =
  | "rustAnalyzerExecutable"
  | "goplsExecutable"
  | "jdtlsExecutable"
  | "kotlinLspExecutable"
  | "csharpLsExecutable";

const roots: string[] = [];
const fakeLanguageServer = resolve(__dirname, "fixtures", "fakeLanguageServer.mjs");
const descriptors: Array<{
  rolloutStage: 3 | 4 | 5;
  descriptor: LanguageServiceDescriptor;
  configKey: ExecutableConfigKey;
  testedVersion: string;
  languageId: string;
  args: string[];
  invokesBuildTools: boolean;
  loadsPlugins: boolean;
  semanticTokens: boolean;
  standaloneWorkspaceRoot: boolean;
  fixtureDirectory: string;
  standalonePath: string;
  projectPath: string;
  projectRoot: string;
  projectMarker: string;
  projectMarkers: LanguageServiceDescriptor["projectMarkers"];
  environmentKeys: string[];
}> = [
  {
    rolloutStage: 3,
    descriptor: rustAnalyzerDescriptor,
    configKey: "rustAnalyzerExecutable",
    testedVersion: "rust-analyzer 2026-08-31",
    languageId: "rust",
    args: [],
    invokesBuildTools: true,
    loadsPlugins: true,
    semanticTokens: true,
    standaloneWorkspaceRoot: true,
    fixtureDirectory: "rustLanguageService",
    standalonePath: "scratch.rs",
    projectPath: "crate/src/lib.rs",
    projectRoot: "crate",
    projectMarker: "Cargo.toml",
    projectMarkers: [
      { kind: "exact", value: "rust-project.json", priority: 130, entryType: "file" },
      { kind: "exact", value: "Cargo.toml", priority: 120, entryType: "file" }
    ],
    environmentKeys: [
      "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME",
      "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"
    ]
  },
  {
    rolloutStage: 4,
    descriptor: goplsDescriptor,
    configKey: "goplsExecutable",
    testedVersion: "gopls 0.23.0",
    languageId: "go",
    args: ["serve"],
    invokesBuildTools: true,
    loadsPlugins: false,
    semanticTokens: true,
    standaloneWorkspaceRoot: true,
    fixtureDirectory: "goLanguageService",
    standalonePath: "scratch.go",
    projectPath: "module/main.go",
    projectRoot: "module",
    projectMarker: "go.mod",
    projectMarkers: [
      { kind: "exact", value: "go.work", priority: 130, entryType: "file" },
      { kind: "exact", value: "go.mod", priority: 120, entryType: "file" }
    ],
    environmentKeys: [
      "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME",
      "GOENV", "GOMODCACHE", "GONOPROXY", "GONOSUMDB", "GOPATH", "GOPRIVATE",
      "GOPROXY", "GOROOT", "GOWORK"
    ]
  },
  {
    rolloutStage: 5,
    descriptor: eclipseJdtLsDescriptor,
    configKey: "jdtlsExecutable",
    testedVersion: "Eclipse JDT LS 1.61.0",
    languageId: "java",
    args: [],
    invokesBuildTools: true,
    loadsPlugins: true,
    semanticTokens: false,
    standaloneWorkspaceRoot: true,
    fixtureDirectory: "javaLanguageService",
    standalonePath: "Scratch.java",
    projectPath: "maven/src/main/java/dev/agentroom/App.java",
    projectRoot: "maven",
    projectMarker: "pom.xml",
    projectMarkers: [
      { kind: "exact", value: ".project", priority: 150, entryType: "file" },
      { kind: "exact", value: "pom.xml", priority: 140, entryType: "file" },
      { kind: "exact", value: "settings.gradle.kts", priority: 130, entryType: "file" },
      { kind: "exact", value: "settings.gradle", priority: 120, entryType: "file" },
      { kind: "exact", value: "build.gradle.kts", priority: 110, entryType: "file" },
      { kind: "exact", value: "build.gradle", priority: 100, entryType: "file" }
    ],
    environmentKeys: [
      "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME",
      "GRADLE_HOME", "JAVA_HOME", "MAVEN_HOME"
    ]
  },
  {
    rolloutStage: 5,
    descriptor: kotlinLspDescriptor,
    configKey: "kotlinLspExecutable",
    testedVersion: "Kotlin LSP 262.9593.0 (alpha)",
    languageId: "kotlin",
    args: ["--stdio"],
    invokesBuildTools: true,
    loadsPlugins: true,
    semanticTokens: true,
    standaloneWorkspaceRoot: true,
    fixtureDirectory: "kotlinLanguageService",
    standalonePath: "scratch.kt",
    projectPath: "gradle/src/main/kotlin/dev/agentroom/App.kt",
    projectRoot: "gradle",
    projectMarker: "settings.gradle.kts",
    projectMarkers: [
      { kind: "exact", value: "settings.gradle.kts", priority: 150, entryType: "file" },
      { kind: "exact", value: "settings.gradle", priority: 140, entryType: "file" },
      { kind: "exact", value: "build.gradle.kts", priority: 130, entryType: "file" },
      { kind: "exact", value: "build.gradle", priority: 120, entryType: "file" },
      { kind: "exact", value: "pom.xml", priority: 110, entryType: "file" }
    ],
    environmentKeys: [
      "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME",
      "GRADLE_HOME", "JAVA_HOME", "MAVEN_HOME"
    ]
  },
  {
    rolloutStage: 5,
    descriptor: csharpLsDescriptor,
    configKey: "csharpLsExecutable",
    testedVersion: "csharp-ls 0.27.0",
    languageId: "csharp",
    args: ["--loglevel", "warning"],
    invokesBuildTools: true,
    loadsPlugins: true,
    semanticTokens: false,
    standaloneWorkspaceRoot: false,
    fixtureDirectory: "csharpLanguageService",
    standalonePath: "Scratch.cs",
    projectPath: "project/Program.cs",
    projectRoot: "project",
    projectMarker: "Fixture.csproj",
    projectMarkers: [
      { kind: "suffix", value: ".slnx", priority: 140, entryType: "file" },
      { kind: "suffix", value: ".sln", priority: 130, entryType: "file" },
      { kind: "suffix", value: ".csproj", priority: 120, entryType: "file" }
    ],
    environmentKeys: [
      "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME",
      "DOTNET_CLI_HOME", "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_CLI_UI_LANGUAGE",
      "DOTNET_NOLOGO", "DOTNET_ROOT", "NUGET_PACKAGES"
    ]
  }
];

function config(root: string, override?: Partial<ServiceConfig>): ServiceConfig {
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
    ...override
  };
}

function jdtLifecycleService(root: string, onFatal: () => void): {
  service: LspEditorLanguageService;
  child(): ChildProcessWithoutNullStreams;
  storagePath(): string;
} {
  let child: ChildProcessWithoutNullStreams | undefined;
  let storagePath: string | undefined;
  const descriptor: LanguageServiceDescriptor = {
    ...eclipseJdtLsDescriptor,
    resolveExecutable: async () => ({
      command: process.execPath,
      args: [fakeLanguageServer, join(root, "server.ndjson"), "normal"]
    })
  };
  const spawner: LanguageServiceSpawner = {
    spawn: (command, args, options) => {
      const storageArgument = args.lastIndexOf("-data");
      storagePath = storageArgument >= 0 ? args[storageArgument + 1] : undefined;
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return child;
    }
  };
  const service = new LspEditorLanguageService({
    descriptor,
    config: config(root),
    projectRoot: root,
    projectName: "JDT lifecycle fixture",
    limits: {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      initializeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500
    },
    spawner,
    onNotification: () => undefined,
    onFatal
  });
  return {
    service,
    child: () => {
      if (!child) throw new Error("JDT lifecycle server did not start");
      return child;
    },
    storagePath: () => {
      if (!storagePath) throw new Error("JDT lifecycle storage was not allocated");
      return storagePath;
    }
  };
}

async function pathIsMissing(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  );
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolveValue) => setTimeout(resolveValue, 10));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("expanded built-in language-service descriptors", () => {
  it("keeps the documented rollout order and the narrow C# project-only exception", () => {
    expect(descriptors.map((entry) => [entry.rolloutStage, entry.descriptor.id])).toEqual([
      [3, "rust_analyzer"],
      [4, "gopls"],
      [5, "eclipse_jdt_ls"],
      [5, "kotlin_lsp"],
      [5, "csharp_ls"]
    ]);
    expect(descriptors
      .filter((entry) => !entry.standaloneWorkspaceRoot)
      .map((entry) => entry.descriptor.id)).toEqual(["csharp_ls"]);
  });

  for (const entry of descriptors) {
    describe(`phase ${entry.rolloutStage} ${entry.descriptor.id} gate`, () => {
      it("pins the server contract and project-loading posture", () => {
        expect(entry.descriptor).toMatchObject({
          testedVersion: entry.testedVersion,
          positionEncoding: "utf-16",
          languageIds: [entry.languageId],
          standaloneWorkspaceRoot: entry.standaloneWorkspaceRoot,
          projectLoading: {
            mayInvokeBuildTools: entry.invokesBuildTools,
            mayLoadPlugins: entry.loadsPlugins
          },
          serverRequests: {
            workDoneProgressCreate: "null",
            workspaceConfiguration: "null_per_item"
          }
        });
        const expectedFeatures = [
          "completion",
          "hover",
          "definition",
          "document_symbols"
        ];
        if (entry.semanticTokens) expectedFeatures.push("semantic_tokens");
        expect(entry.descriptor.featureKinds).toEqual(expectedFeatures);
        expect(entry.descriptor.projectMarkers).toEqual(entry.projectMarkers);
        expect(entry.descriptor.environmentKeys).toEqual(entry.environmentKeys);
        if (entry.descriptor === goplsDescriptor) {
          expect(entry.descriptor.initializationOptions).toEqual({ semanticTokens: true });
        }
      });

      it("resolves its no-marker policy and nearest admitted project marker", async () => {
        const root = resolve(__dirname, "fixtures", entry.fixtureDirectory);
        const workspace: LocalWorkspace = {
          id: `workspace-${entry.languageId}`,
          name: `${entry.languageId} fixtures`,
          path: root,
          kind: "user_selected",
          trustedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
          git: { isRepository: false }
        };

        const standaloneResolution = resolveLanguageServiceProject(
          workspace,
          entry.standalonePath,
          entry.languageId,
          [entry.descriptor]
        );
        if (entry.standaloneWorkspaceRoot) {
          const standalone = await standaloneResolution;
          expect(standalone).toMatchObject({
            descriptor: entry.descriptor,
            relativeProjectRoot: ""
          });
          expect(standalone).not.toHaveProperty("marker");
        } else {
          await expect(standaloneResolution).rejects.toMatchObject({ code: "project_not_found" });
        }
        await expect(resolveLanguageServiceProject(
          workspace,
          entry.projectPath,
          entry.languageId,
          [entry.descriptor]
        )).resolves.toMatchObject({
          descriptor: entry.descriptor,
          relativeProjectRoot: entry.projectRoot,
          marker: entry.projectMarker
        });
      });

      it("admits only its configured executable and fixed arguments", async () => {
        const root = await mkdtemp(join(tmpdir(), `agentroom-${entry.descriptor.id}-`));
        roots.push(root);
        const executable = join(root, "language-server");
        await writeFile(executable, "#!/bin/sh\nexit 0\n");
        await chmod(executable, 0o700);

        const configured = config(root, { [entry.configKey]: executable });
        const launch = await entry.descriptor.resolveExecutable(configured);
        expect(launch).toEqual({ command: await realpath(executable), args: entry.args });
        expect(isAbsolute(launch.command)).toBe(true);
        expect((await lstat(launch.command)).isFile()).toBe(true);
        expect(entry.descriptor.configured(config(root))).toBe(false);
        expect(entry.descriptor.configured(configured)).toBe(true);

        const expandedProjection = new LanguageServiceRegistry(configured).projection().slice(3);
        expect(expandedProjection.map((service) => [service.id, service.configured])).toEqual(
          descriptors.map((candidate) => [
            candidate.descriptor.id,
            candidate.descriptor === entry.descriptor
          ])
        );
      });
    });
  }

  it("rejects missing, relative, and symlink executable overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-expanded-lsp-invalid-"));
    roots.push(root);
    const executable = join(root, "rust-analyzer");
    const alias = join(root, "rust-analyzer-alias");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    await symlink(executable, alias);

    await expect(rustAnalyzerDescriptor.resolveExecutable(config(root)))
      .rejects.toMatchObject({ code: "service_unavailable" });
    await expect(rustAnalyzerDescriptor.resolveExecutable(config(root, {
      rustAnalyzerExecutable: "rust-analyzer"
    }))).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(rustAnalyzerDescriptor.resolveExecutable(config(root, {
      rustAnalyzerExecutable: alias
    }))).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("gives JDT LS isolated temporary process data and idempotent cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-jdtls-launch-"));
    roots.push(root);
    const executable = join(root, "jdtls");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);

    const launches = await Promise.all([
      prepareLanguageServiceLaunch(eclipseJdtLsDescriptor, config(root, { jdtlsExecutable: executable })),
      prepareLanguageServiceLaunch(eclipseJdtLsDescriptor, config(root, { jdtlsExecutable: executable }))
    ]);
    const [storagePath, secondStoragePath] = launches.map((launch) => launch.args[1]);
    try {
      expect(launches[0].args.slice(0, 1)).toEqual(["-data"]);
      expect(isAbsolute(storagePath)).toBe(true);
      expect(secondStoragePath).not.toBe(storagePath);
      expect((await lstat(storagePath)).isDirectory()).toBe(true);
      expect((await lstat(secondStoragePath)).isDirectory()).toBe(true);
    } finally {
      await Promise.all(launches.map((launch) => launch.cleanup()));
    }
    await expect(lstat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(secondStoragePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(launches[0].cleanup()).resolves.toBeUndefined();
  });

  it("removes JDT LS process data after graceful service close", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-jdtls-graceful-"));
    roots.push(root);
    const lifecycle = jdtLifecycleService(root, () => undefined);
    try {
      await expect(lifecycle.service.probe()).resolves.toBe("ready");
      const storagePath = lifecycle.storagePath();
      expect((await lstat(storagePath)).isDirectory()).toBe(true);
      await lifecycle.service.close();
      expect(await pathIsMissing(storagePath)).toBe(true);
    } finally {
      await lifecycle.service.close({ force: true });
    }
  });

  it("removes JDT LS process data after a fatal service exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-jdtls-fatal-"));
    roots.push(root);
    let fatal = false;
    const lifecycle = jdtLifecycleService(root, () => { fatal = true; });
    try {
      await expect(lifecycle.service.probe()).resolves.toBe("ready");
      const storagePath = lifecycle.storagePath();
      expect((await lstat(storagePath)).isDirectory()).toBe(true);
      lifecycle.child().kill("SIGKILL");
      await waitFor(async () => fatal && await pathIsMissing(storagePath));
    } finally {
      await lifecycle.service.close({ force: true });
    }
  });
});
