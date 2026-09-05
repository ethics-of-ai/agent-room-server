import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  csharpLsDescriptor,
  eclipseJdtLsDescriptor,
  goplsDescriptor,
  kotlinLspDescriptor,
  rustAnalyzerDescriptor
} from "../src/editor/languageServices/registry";
import type { LanguageServiceDescriptor } from "../src/editor/languageServices/types";
import {
  completionLabels,
  definitions,
  documentSymbolNames,
  hoverContents,
  LanguageServiceLiveTestHarness,
  semanticTokenData
} from "./support/languageServiceLiveTestHarness";

interface ExpandedLiveCase {
  rolloutStage: 3 | 4 | 5;
  name: string;
  executableEnvironmentName: string;
  descriptor: LanguageServiceDescriptor;
  config: (executable: string) => Partial<ServiceConfig>;
  fixtureDirectory: string;
  languageId: string;
  awaitDiagnostics?: boolean;
  featureFixture: {
    standalone: boolean;
    path: string;
    definition: { needle: string; occurrence: number; expectedPath: string };
    hover: { needle: string; occurrence: number; expectedText: string };
    completion: { needle: string; offset: number; expectedLabel: string };
    symbols: string[];
    root: string;
    marker?: string;
  };
  project: {
    path: string;
    definition: { needle: string; occurrence: number; expectedPath: string };
    root: string;
    marker: string;
  };
}

const cases: ExpandedLiveCase[] = [
  {
    rolloutStage: 3,
    name: "rust-analyzer",
    executableEnvironmentName: "RUST_ANALYZER_EXECUTABLE",
    descriptor: rustAnalyzerDescriptor,
    config: (executable) => ({ rustAnalyzerExecutable: executable }),
    fixtureDirectory: "rustLanguageService",
    languageId: "rust",
    featureFixture: {
      standalone: true,
      path: "scratch.rs",
      definition: { needle: "double", occurrence: 1, expectedPath: "scratch.rs" },
      hover: { needle: "double", occurrence: 1, expectedText: "double" },
      completion: { needle: "result.abs", offset: "result.".length, expectedLabel: "abs" },
      symbols: ["double", "main"],
      root: "."
    },
    project: {
      path: "crate/src/lib.rs",
      definition: { needle: "double", occurrence: 0, expectedPath: "crate/src/math.rs" },
      root: "crate",
      marker: "Cargo.toml"
    }
  },
  {
    rolloutStage: 4,
    name: "gopls",
    executableEnvironmentName: "GOPLS_EXECUTABLE",
    descriptor: goplsDescriptor,
    config: (executable) => ({ goplsExecutable: executable }),
    fixtureDirectory: "goLanguageService",
    languageId: "go",
    featureFixture: {
      standalone: true,
      path: "scratch.go",
      definition: { needle: "double", occurrence: 1, expectedPath: "scratch.go" },
      hover: { needle: "double", occurrence: 1, expectedText: "double" },
      completion: { needle: "fmt.Println", offset: "fmt.".length, expectedLabel: "Println" },
      symbols: ["double", "main"],
      root: "."
    },
    project: {
      path: "module/main.go",
      definition: { needle: "Double", occurrence: 0, expectedPath: "module/math/math.go" },
      root: "module",
      marker: "go.mod"
    }
  },
  {
    rolloutStage: 5,
    name: "Eclipse JDT LS",
    executableEnvironmentName: "JDTLS_EXECUTABLE",
    descriptor: eclipseJdtLsDescriptor,
    config: (executable) => ({ jdtlsExecutable: executable }),
    fixtureDirectory: "javaLanguageService",
    languageId: "java",
    featureFixture: {
      standalone: true,
      path: "Scratch.java",
      definition: { needle: "doubleValue", occurrence: 1, expectedPath: "Scratch.java" },
      hover: { needle: "doubleValue", occurrence: 1, expectedText: "doubleValue" },
      completion: { needle: "System.out", offset: "System.".length, expectedLabel: "out" },
      symbols: ["Scratch", "doubleValue", "main"],
      root: "."
    },
    project: {
      path: "maven/src/main/java/dev/agentroom/App.java",
      definition: {
        needle: "Greeter",
        occurrence: 0,
        expectedPath: "maven/src/main/java/dev/agentroom/Greeter.java"
      },
      root: "maven",
      marker: "pom.xml"
    }
  },
  {
    rolloutStage: 5,
    name: "Kotlin LSP",
    executableEnvironmentName: "KOTLIN_LSP_EXECUTABLE",
    descriptor: kotlinLspDescriptor,
    config: (executable) => ({ kotlinLspExecutable: executable }),
    fixtureDirectory: "kotlinLanguageService",
    languageId: "kotlin",
    featureFixture: {
      standalone: true,
      path: "scratch.kt",
      definition: { needle: "double", occurrence: 1, expectedPath: "scratch.kt" },
      hover: { needle: "double", occurrence: 1, expectedText: "double" },
      completion: { needle: "result.inc", offset: "result.".length, expectedLabel: "inc" },
      symbols: ["double", "main"],
      root: "."
    },
    project: {
      path: "gradle/src/main/kotlin/dev/agentroom/App.kt",
      definition: {
        needle: "Greeter",
        occurrence: 0,
        expectedPath: "gradle/src/main/kotlin/dev/agentroom/Greeter.kt"
      },
      root: "gradle",
      marker: "settings.gradle.kts"
    }
  },
  {
    rolloutStage: 5,
    name: "csharp-ls",
    executableEnvironmentName: "CSHARP_LS_EXECUTABLE",
    descriptor: csharpLsDescriptor,
    config: (executable) => ({ csharpLsExecutable: executable }),
    fixtureDirectory: "csharpLanguageService",
    languageId: "csharp",
    awaitDiagnostics: false,
    featureFixture: {
      standalone: false,
      path: "project/Greeter.cs",
      definition: { needle: "Message", occurrence: 1, expectedPath: "project/Greeter.cs" },
      hover: { needle: "Message", occurrence: 1, expectedText: "Message" },
      completion: { needle: "name.Trim", offset: "name.".length, expectedLabel: "Trim" },
      symbols: ["Greeter", "Message(string name)", "Greeting(string name)"],
      root: "project",
      marker: "Fixture.csproj"
    },
    project: {
      path: "project/Program.cs",
      definition: {
        needle: "Greeter",
        occurrence: 0,
        expectedPath: "project/Greeter.cs"
      },
      root: "project",
      marker: "Fixture.csproj"
    }
  }
];

let harness: LanguageServiceLiveTestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("expanded production language-service descriptors", () => {
  for (const entry of cases) {
    const executable = process.env[entry.executableEnvironmentName];
    it.skipIf(!executable)(`phase ${entry.rolloutStage} exercises ${entry.name} against its declared fixtures`, async () => {
      expect(entry.featureFixture.standalone).toBe(entry.descriptor.standaloneWorkspaceRoot);
      harness = await LanguageServiceLiveTestHarness.create({
        fixtureSource: resolve(__dirname, "fixtures", entry.fixtureDirectory),
        tempPrefix: `agentroom-${entry.descriptor.id}-live-`,
        workspaceId: `workspace-${entry.descriptor.id}`,
        workspaceName: `${entry.name} fixtures`,
        descriptor: entry.descriptor,
        configOverrides: entry.config(executable!),
        diagnosticsTimeoutMs: 30_000,
        awaitDiagnostics: entry.awaitDiagnostics
      });

      const featureText = await harness.open("features", entry.featureFixture.path, entry.languageId);
      expect(definitions(await harness.requestAt(
        "features",
        featureText,
        "definition",
        entry.featureFixture.definition.needle,
        entry.featureFixture.definition.occurrence
      ))).toContainEqual(expect.objectContaining({ path: entry.featureFixture.definition.expectedPath }));
      expect(hoverContents(await harness.requestAt(
        "features",
        featureText,
        "hover",
        entry.featureFixture.hover.needle,
        entry.featureFixture.hover.occurrence
      ))).toContain(entry.featureFixture.hover.expectedText);
      expect(completionLabels(await harness.requestAt(
        "features",
        featureText,
        "completion",
        entry.featureFixture.completion.needle,
        0,
        entry.featureFixture.completion.offset
      ))).toContain(entry.featureFixture.completion.expectedLabel);
      expect(documentSymbolNames(await harness.requestFeature("features", {
        requestId: "feature-document-symbols",
        clientVersion: 1,
        kind: "document_symbols"
      }))).toEqual(expect.arrayContaining(entry.featureFixture.symbols));
      if (entry.descriptor.featureKinds.includes("semantic_tokens")) {
        const tokenData = semanticTokenData(await harness.requestFeature("features", {
          requestId: "feature-semantic-tokens",
          clientVersion: 1,
          kind: "semantic_tokens"
        }));
        expect(tokenData.length).toBeGreaterThan(0);
        expect(tokenData.length % 5).toBe(0);
      }
      expect(harness.framesFor("features")).toContainEqual(expect.objectContaining({
        type: "status",
        readiness: "ready",
        project: {
          root: entry.featureFixture.root,
          ...(entry.featureFixture.marker ? { marker: entry.featureFixture.marker } : {})
        }
      }));
      if (entry.awaitDiagnostics !== false) {
        expect(harness.diagnosticsFor("features")).toEqual([]);
      }

      const project = await harness.open("project", entry.project.path, entry.languageId);
      expect(definitions(await harness.requestAt(
        "project",
        project,
        "definition",
        entry.project.definition.needle,
        entry.project.definition.occurrence
      ))).toContainEqual(expect.objectContaining({ path: entry.project.definition.expectedPath }));
      expect(harness.framesFor("project")).toContainEqual(expect.objectContaining({
        type: "status",
        readiness: "ready",
        project: { root: entry.project.root, marker: entry.project.marker }
      }));
      if (entry.awaitDiagnostics !== false) {
        expect(harness.diagnosticsFor("project")).toEqual([]);
      }
      expect(harness.registry.projection()).toMatchObject([{ ready: true }]);
    }, 90_000);
  }
});
