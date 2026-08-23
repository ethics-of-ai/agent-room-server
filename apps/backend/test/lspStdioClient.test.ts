import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LspStdioClient } from "./support/LspStdioClient";

/// SPIKE (2026-06-19) D0 — LSP feasibility. Proves the AgentRoom backend can host a
/// real language server (sourcekit-lsp, dogfooding this repo's Swift) and round-trip
/// LSP requests bounded to a workspace root, over the minimal stdio transport.
///
/// Skipped automatically where sourcekit-lsp is unavailable (no Xcode toolchain), so
/// `pnpm test` stays green on machines without it.

function resolveSourcekitLsp(): string | null {
  try {
    const path = execFileSync("xcrun", ["--find", "sourcekit-lsp"], { encoding: "utf8" }).trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

const sourcekitLspPath = resolveSourcekitLsp();

describe("LspStdioClient (D0 sourcekit-lsp feasibility)", () => {
  it.skipIf(sourcekitLspPath === null)(
    "initializes sourcekit-lsp and round-trips a request bounded to a workspace root",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agentroom-lsp-d0-"));
      const filePath = join(root, "Sample.swift");
      writeFileSync(
        filePath,
        [
          "struct Sample {",
          "    let id: Int = 1",
          "    func greet() -> String { \"hi \\(id)\" }",
          "}",
          ""
        ].join("\n"),
        "utf8"
      );

      const client = new LspStdioClient(sourcekitLspPath as string, [], root);
      const diagnosticsNotifications: unknown[] = [];
      client.onNotification((method, params) => {
        if (method === "textDocument/publishDiagnostics") diagnosticsNotifications.push(params);
      });

      try {
        // 1) initialize handshake bounded to the workspace root (the production
        //    rootUri is the registered workspace).
        const initResult = (await client.request(
          "initialize",
          {
            processId: process.pid,
            rootUri: pathToFileURL(root).toString(),
            capabilities: {},
            workspaceFolders: null
          },
          20_000
        )) as { capabilities?: Record<string, unknown> } | null;

        expect(initResult).toBeTruthy();
        expect(initResult?.capabilities).toBeTruthy();

        client.notify("initialized", {});

        // 2) open the document; its text is the buffer the editor would hold.
        const uri = pathToFileURL(filePath).toString();
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "swift", version: 1, text: readFileSync(filePath, "utf8") }
        });

        // 3) request/response round-trip. documentSymbol is syntactic, so it works
        //    without a full SwiftPM build context. Resolving within the timeout
        //    (vs. throwing) is itself the proof that framing + id-correlation work.
        const symbols = await client.request(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
          20_000
        );
        expect(symbols === null || Array.isArray(symbols)).toBe(true);

        // Evidence in the run output (not asserted: standalone-file semantics vary).
        const symbolCount = Array.isArray(symbols) ? symbols.length : 0;
        // eslint-disable-next-line no-console
        console.info(
          `[D0] sourcekit-lsp round-trip OK — documentSymbol=${symbolCount}, ` +
            `publishDiagnostics notifications=${diagnosticsNotifications.length}`
        );
      } finally {
        try {
          await client.request("shutdown", null, 3_000);
        } catch {
          // best-effort; we SIGKILL below regardless
        }
        client.notify("exit", null);
        client.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
    40_000
  );
});
