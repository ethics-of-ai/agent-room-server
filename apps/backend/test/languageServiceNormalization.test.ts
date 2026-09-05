import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { languageServiceClientFrameSchema } from "../src/domain/languageServiceSchemas";
import { normalizeDiagnostics, normalizeFeatureResult } from "../src/editor/languageServices/normalize";
import { clampUtf8, validPosition, validRange } from "../src/editor/languageServices/text";

const roots: string[] = [];
const position = { line: 0, character: 0 };
const range = { start: position, end: { line: 0, character: 1 } };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("language-service closed protocol and result bounds", () => {
  it("preserves code punctuation in plain text, marked code, and documentation", async () => {
    const contents = "foo_bar: Array<String>; lhs > rhs; *ptr != ~mask; #define VALUE";
    for (const value of [contents, { kind: "plaintext", value: contents }, { language: "swift", value: contents }]) {
      expect(await normalizeFeatureResult("hover", { contents: value }, { text: "x", workspaceRoot: "/tmp" }))
        .toMatchObject({ hover: { contents }, truncated: false });
    }
    expect(normalizeDiagnostics({ diagnostics: [{ range, message: contents }] }, "x"))
      .toMatchObject({ diagnostics: [{ message: contents }], truncated: false });
    const markdown = "```swift\nlet foo_bar: Array<String> = []\n```";
    expect(await normalizeFeatureResult("hover", { contents: { kind: "markdown", value: markdown } }, {
      text: "x", workspaceRoot: "/tmp"
    })).toMatchObject({ hover: { contents: markdown }, truncated: false });
  });

  it("preserves plain completion insertion text separately from its display label", async () => {
    expect(await normalizeFeatureResult("completion", [
      { label: "greet(name: string): void", insertText: "greet", insertTextFormat: 1 },
      { label: "empty", insertText: "" },
      { label: "oversized", insertText: "x".repeat(256 * 1024 + 1) },
      { label: "snippet", insertText: "${1:name}", insertTextFormat: 2 }
    ], { text: "g", workspaceRoot: "/tmp" })).toEqual({
      kind: "completion", items: [
        { label: "greet(name: string): void", kind: "other", insertText: "greet" },
        { label: "empty", kind: "other", insertText: "" }
      ], truncated: true
    });
  });

  it("accepts every named client frame and no raw method", () => {
    const frames = [
      { type: "open", path: "main.swift", languageId: "swift", clientVersion: 1, text: "x" },
      { type: "change", clientVersion: 2, text: "y" },
      { type: "request", requestId: "one", clientVersion: 2, kind: "hover", position },
      { type: "cancel", requestId: "one" },
      { type: "close" }
    ];
    for (const frame of frames) expect(languageServiceClientFrameSchema.safeParse(frame).success).toBe(true);
    expect(languageServiceClientFrameSchema.safeParse({
      type: "request",
      requestId: "raw",
      clientVersion: 1,
      kind: "hover",
      method: "workspace/executeCommand",
      position
    }).success).toBe(false);
    expect(languageServiceClientFrameSchema.safeParse({
      type: "change", clientVersion: 0, text: "x"
    }).success).toBe(false);
  });

  it("uses UTF-16 code units for surrogate pairs, combining marks, and non-BMP scalars", () => {
    const text = "a😀e\u0301𐐷z\n";
    expect(text.split("\n")[0].length).toBe(8);
    for (const character of [0, 1, 3, 4, 5, 7, 8]) {
      expect(validPosition(text, { line: 0, character })).toBe(true);
    }
    expect(validPosition(text, { line: 0, character: 2 })).toBe(false);
    expect(validPosition(text, { line: 0, character: 6 })).toBe(false);
    expect(validPosition(text, { line: 0, character: 9 })).toBe(false);
    expect(validRange(text, { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } })).toBe(true);
    expect(validRange(text, { start: { line: 0, character: 3 }, end: { line: 0, character: 1 } })).toBe(false);
    expect(clampUtf8("😀😀", 5)).toEqual({ value: "😀", truncated: true });
  });

  it("caps diagnostics, completions, strings, and omits active commands", async () => {
    const text = "value\n";
    const diagnostics = normalizeDiagnostics({
      diagnostics: Array.from({ length: 501 }, () => ({
        range,
        message: `<b>${"x".repeat(5 * 1024)}</b>`,
        severity: 1
      }))
    }, text);
    expect(diagnostics.diagnostics).toHaveLength(500);
    expect(Buffer.byteLength(diagnostics.diagnostics[0].message, "utf8")).toBe(4 * 1024);
    expect(diagnostics.diagnostics[0].message).toContain("<b>");
    expect(diagnostics.truncated).toBe(true);

    const completion = await normalizeFeatureResult("completion", {
      items: [
        ...Array.from({ length: 201 }, (_, index) => ({
          label: index === 0 ? "l".repeat(300) : `item-${index}`,
          kind: 3,
          detail: "d".repeat(5 * 1024),
          documentation: "z".repeat(17 * 1024)
        })),
        { label: "command", command: { command: "run" } },
        { label: "extra edit", additionalTextEdits: [{ range, newText: "bad" }] },
        { label: "snippet", insertTextFormat: 2, insertText: "${1:value}" }
      ]
    }, { text, workspaceRoot: "/tmp" });
    expect(completion).toMatchObject({ kind: "completion", truncated: true });
    if (completion.kind !== "completion") throw new Error("wrong result kind");
    expect(completion.items).toHaveLength(200);
    expect(Buffer.byteLength(completion.items[0].label, "utf8")).toBe(256);
    expect(Buffer.byteLength(completion.items[0].detail ?? "", "utf8")).toBe(4 * 1024);
    expect(Buffer.byteLength(completion.items[0].documentation ?? "", "utf8")).toBe(16 * 1024);
    expect(completion.items.map((item) => item.label)).not.toContain("command");
  });

  it("caps definitions and filters locations outside the registered workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-language-definitions-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "agentroom-language-definitions-outside-"));
    roots.push(root, outsideRoot);
    const locations: Array<{ uri: string; range: typeof range }> = [];
    for (let index = 0; index < 21; index += 1) {
      const path = join(root, `${index}.swift`);
      await writeFile(path, "x\n");
      locations.push({ uri: pathToFileURL(path).toString(), range });
    }
    const outside = join(outsideRoot, "outside.swift");
    await writeFile(outside, "x\n");
    locations.unshift({ uri: pathToFileURL(outside).toString(), range });

    const result = await normalizeFeatureResult("definition", locations, {
      text: "x\n",
      workspaceRoot: await realpath(root)
    });
    expect(result).toMatchObject({ kind: "definition", truncated: true });
    if (result.kind !== "definition") throw new Error("wrong result kind");
    expect(result.locations).toHaveLength(20);
    expect(result.locations.every((location) => !location.path.startsWith("/"))).toBe(true);
  });

  it("caps symbol nodes/depth and semantic-token integers", async () => {
    const text = "x\n";
    let deep: Record<string, unknown> = { name: "leaf", kind: 23, range, selectionRange: range, children: [] };
    for (let depth = 0; depth < 17; depth += 1) {
      deep = { name: `node-${depth}`, kind: 23, range, selectionRange: range, children: [deep] };
    }
    const symbols = await normalizeFeatureResult("document_symbols", [
      deep,
      ...Array.from({ length: 1_001 }, (_, index) => ({
        name: `symbol-${index}`, kind: 12, range, selectionRange: range, children: []
      }))
    ], { text, workspaceRoot: "/tmp" });
    expect(symbols).toMatchObject({ kind: "document_symbols", truncated: true });
    if (symbols.kind !== "document_symbols") throw new Error("wrong result kind");
    const count = (nodes: typeof symbols.symbols): number => nodes.reduce(
      (total, node) => total + 1 + count(node.children),
      0
    );
    expect(count(symbols.symbols)).toBe(1_000);

    const tokens = await normalizeFeatureResult(
      "semantic_tokens",
      { data: Array.from({ length: 100_005 }, () => 0) },
      { text, workspaceRoot: "/tmp" }
    );
    expect(tokens).toMatchObject({ kind: "semantic_tokens", truncated: true });
    if (tokens.kind !== "semantic_tokens") throw new Error("wrong result kind");
    expect(tokens.tokens.data).toHaveLength(100_000);
  });
});
