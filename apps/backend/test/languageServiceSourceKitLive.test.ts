import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import { LanguageServiceHost } from "../src/editor/languageServices/LanguageServiceHost";
import { LanguageServiceRegistry, sourceKitLspDescriptor } from "../src/editor/languageServices/registry";
import type { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";

function sourceKitPath(): string | undefined {
  try {
    return execFileSync("xcrun", ["--find", "sourcekit-lsp"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const executable = sourceKitPath();

describe("production SourceKit-LSP adapter", () => {
  it.skipIf(!executable)("serves every closed feature through a registered Swift package", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-sourcekit-live-"));
    const filePath = join(root, "Sources", "Fixture", "Greeter.swift");
    const text = [
      "public struct Greeter {",
      "    public let message: String",
      "    public func greet() -> String { message }",
      "}",
      ""
    ].join("\n");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(join(root, "Package.swift"), [
      "// swift-tools-version: 6.0",
      "import PackageDescription",
      "let package = Package(name: \"Fixture\", targets: [.target(name: \"Fixture\")] )",
      ""
    ].join("\n"));
    await writeFile(filePath, text);
    const workspace: LocalWorkspace = {
      id: "workspace-sourcekit",
      name: "SourceKit fixture",
      path: root,
      kind: "user_selected",
      trustedAt: new Date(0).toISOString(),
      lastOpenedAt: new Date(0).toISOString(),
      git: { isRepository: false }
    };
    const config: ServiceConfig = {
      runnerKind: "codex",
      host: "127.0.0.1",
      port: 8787,
      workspaceRoot: root,
      stateDir: join(root, ".state"),
      editorCatalogDir: join(root, ".catalog"),
      requireAuth: false,
      gitCommandTimeoutMs: 30_000,
      codexArgs: [],
      languageServicesEnabled: true,
      sourcekitLspExecutable: executable
    };
    const registry = new LanguageServiceRegistry(config, [sourceKitLspDescriptor]);
    const workspaces = {
      findByIdWithoutGitRefresh: async () => workspace
    } as unknown as LocalWorkspaceRegistry;
    const host = new LanguageServiceHost({ config, registry, workspaces });
    try {
      await host.openDocument({
        id: "sourcekit-tab",
        workspaceId: workspace.id,
        send: () => undefined
      }, {
        path: "Sources/Fixture/Greeter.swift",
        languageId: "swift",
        clientVersion: 1,
        text
      });
      const completion = await host.requestFeature("sourcekit-tab", {
        requestId: "completion",
        clientVersion: 1,
        kind: "completion",
        position: { line: 2, character: 36 }
      });
      expect(completion).toMatchObject({
        type: "response",
        result: { kind: "completion", items: expect.any(Array) }
      });

      const hover = await host.requestFeature("sourcekit-tab", {
        requestId: "hover",
        clientVersion: 1,
        kind: "hover",
        position: { line: 2, character: 38 }
      });
      expect(hover).toMatchObject({
        type: "response",
        result: { kind: "hover" }
      });

      const definition = await host.requestFeature("sourcekit-tab", {
        requestId: "definition",
        clientVersion: 1,
        kind: "definition",
        position: { line: 2, character: 38 }
      });
      expect(definition).toMatchObject({
        type: "response",
        result: { kind: "definition", locations: expect.any(Array) }
      });

      const symbols = await host.requestFeature("sourcekit-tab", {
        requestId: "symbols",
        clientVersion: 1,
        kind: "document_symbols"
      });
      expect(symbols).toMatchObject({
        type: "response",
        result: { kind: "document_symbols", symbols: expect.any(Array) }
      });

      const semanticTokens = await host.requestFeature("sourcekit-tab", {
        requestId: "semantic-tokens",
        clientVersion: 1,
        kind: "semantic_tokens"
      });
      expect(semanticTokens).toMatchObject({
        type: "response",
        result: { kind: "semantic_tokens", tokens: { data: expect.any(Array) } }
      });
      expect(registry.projection()).toMatchObject([{ ready: true }]);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
