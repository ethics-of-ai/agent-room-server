import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LspStdioClient } from "./support/LspStdioClient";

function resolveSourcekitLsp(): string | null {
  try {
    const path = execFileSync("xcrun", ["--find", "sourcekit-lsp"], { encoding: "utf8" }).trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

const sourcekitLspPath = resolveSourcekitLsp();
const typescriptLspPath = resolve(__dirname, "../node_modules/.bin/typescript-language-server");

const capabilities = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { configuration: true, workspaceFolders: true },
  window: { workDoneProgress: true },
  textDocument: {
    publishDiagnostics: { relatedInformation: true, versionSupport: true },
    completion: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    definition: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: true, range: false },
      tokenTypes: [
        "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
        "parameter", "variable", "property", "enumMember", "event", "function", "method",
        "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator",
        "decorator"
      ],
      tokenModifiers: [
        "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
        "modification", "documentation", "defaultLibrary"
      ],
      formats: ["relative"]
    }
  }
};

interface Fixture {
  root: string;
  filePath: string;
  languageId: string;
  text: string;
  positions: Record<"completion" | "hover" | "definition", { line: number; character: number }>;
}

function diagnosticsAfterOpen(client: LspStdioClient, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error("publishDiagnostics timed out"));
    }, timeoutMs);
    timer.unref();
    const remove = client.onNotification((method, params) => {
      if (method !== "textDocument/publishDiagnostics") return;
      clearTimeout(timer);
      remove();
      resolveValue(params);
    });
  });
}

async function exerciseServer(command: string, args: string[], fixture: Fixture): Promise<void> {
  const client = new LspStdioClient(command, args, fixture.root, {
    serverRequestHandler: (method, params) => {
      if (method === "window/workDoneProgress/create") return null;
      if (method === "workspace/configuration") {
        return ((params as { items?: unknown[] })?.items ?? []).map(() => null);
      }
      throw new Error("unadmitted server request");
    }
  });
  const uri = pathToFileURL(fixture.filePath).toString();

  try {
    const initialized = (await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(fixture.root).toString(),
      workspaceFolders: [{ uri: pathToFileURL(fixture.root).toString(), name: "fixture" }],
      capabilities
    }, 20_000)) as { capabilities?: Record<string, unknown> };
    expect(initialized.capabilities).toBeTruthy();
    expect(initialized.capabilities?.completionProvider).toBeTruthy();
    expect(initialized.capabilities?.definitionProvider).toBeTruthy();
    expect(initialized.capabilities?.semanticTokensProvider).toBeTruthy();

    client.notify("initialized", {});
    const diagnostics = diagnosticsAfterOpen(client);
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: fixture.languageId,
        version: 1,
        text: readFileSync(fixture.filePath, "utf8")
      }
    });
    const textDocument = { uri };
    const completion = await client.request("textDocument/completion", {
      textDocument,
      position: fixture.positions.completion,
      context: { triggerKind: 1 }
    }, 20_000);
    const hover = await client.request("textDocument/hover", {
      textDocument,
      position: fixture.positions.hover
    }, 20_000);
    const definition = await client.request("textDocument/definition", {
      textDocument,
      position: fixture.positions.definition
    }, 20_000);
    const symbols = await client.request("textDocument/documentSymbol", { textDocument }, 20_000);
    const tokens = await client.request("textDocument/semanticTokens/full", { textDocument }, 20_000);

    expect(completion).toBeTruthy();
    expect(hover).toBeTruthy();
    expect(Array.isArray(definition) ? definition.length : definition).toBeTruthy();
    expect(Array.isArray(symbols)).toBe(true);
    expect(tokens).toBeTruthy();
    expect(await diagnostics).toBeTruthy();

    const cancelled = client.requestWithHandle("workspace/symbol", { query: "Greeter" }, 5_000);
    client.cancelRequest(cancelled.id);
    await cancelled.promise.catch(() => null);
    expect(client.wireStats.inboundFrames).toBeGreaterThan(0);
    expect(client.wireStats.largestInboundPayloadBytes).toBeGreaterThan(0);
    expect(client.observedServerRequestMethods.every((method) => [
      "window/workDoneProgress/create",
      "workspace/configuration"
    ].includes(method))).toBe(true);

    client.notify("textDocument/didClose", { textDocument });
    await client.request("shutdown", null, 3_000);
    client.notify("exit", null);
    await expect(client.waitForExit(3_000)).resolves.toMatchObject({ code: 0 });
  } finally {
    client.dispose();
  }
}

function swiftFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentroom-sourcekit-project-"));
  const filePath = join(root, "Sources", "Fixture", "Greeter.swift");
  const text = [
    "public struct Greeter {",
    "    public let message: String",
    "    public init(message: String) { self.message = message }",
    "    public func greet() -> String { message.uppercased() }",
    "}",
    "public func sample() {",
    "    let value = Greeter(message: \"hello\")",
    "    value.",
    "}",
    ""
  ].join("\n");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(join(root, "Package.swift"), [
    "// swift-tools-version: 6.0",
    "import PackageDescription",
    "let package = Package(name: \"Fixture\", targets: [.target(name: \"Fixture\")])",
    ""
  ].join("\n"));
  writeFileSync(filePath, text);
  return {
    root,
    filePath,
    languageId: "swift",
    text,
    positions: {
      completion: { line: 7, character: 10 },
      hover: { line: 6, character: 18 },
      definition: { line: 6, character: 18 }
    }
  };
}

function typescriptFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentroom-typescript-project-"));
  const filePath = join(root, "src", "index.ts");
  const text = [
    "export function greet(name: string): string { return `Hello ${name}`; }",
    "const message = greet(\"World\");",
    "const broken: number = \"wrong\";",
    "message.",
    ""
  ].join("\n");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true},\"include\":[\"src\"]}\n");
  writeFileSync(filePath, text);
  return {
    root,
    filePath,
    languageId: "typescript",
    text,
    positions: {
      completion: { line: 3, character: 8 },
      hover: { line: 1, character: 18 },
      definition: { line: 1, character: 18 }
    }
  };
}

describe("LspStdioClient live Phase 0 compatibility", () => {
  it.skipIf(sourcekitLspPath === null)("exercises the frozen feature set against SourceKit-LSP", async () => {
    const fixture = swiftFixture();
    try {
      await exerciseServer(sourcekitLspPath as string, [], fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 40_000);

  it("exercises the same feature set against the pinned TypeScript service", async () => {
    const fixture = typescriptFixture();
    try {
      await exerciseServer(typescriptLspPath, ["--stdio"], fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 40_000);
});
