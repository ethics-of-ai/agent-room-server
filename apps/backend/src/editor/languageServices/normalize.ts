import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LanguageServiceCompletion,
  LanguageServiceCompletionKind,
  LanguageServiceDefinition,
  LanguageServiceDiagnostic,
  LanguageServiceDocumentSymbol,
  LanguageServiceFeatureKind,
  LanguageServiceFeatureResult,
  LanguageServiceHover,
  LanguageServicePosition,
  LanguageServiceRange
} from "../../domain/languageService";
import { isInside } from "../../util/pathBounding";
import { indexableRelativePath } from "../../workspace/explorer/paths";
import { clampUtf8, comparePositions, validRange } from "./text";

const completionKinds: LanguageServiceCompletionKind[] = [
  "text", "method", "function", "constructor", "field", "variable", "class", "interface",
  "module", "property", "value", "enum", "keyword", "file", "reference", "folder",
  "enum_member", "constant", "struct", "event", "operator", "type_parameter", "other"
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function position(value: unknown): LanguageServicePosition | undefined {
  const item = record(value);
  return item && Number.isSafeInteger(item.line) && Number.isSafeInteger(item.character)
    && (item.line as number) >= 0 && (item.character as number) >= 0
    ? { line: item.line as number, character: item.character as number }
    : undefined;
}

function range(value: unknown, text?: string): LanguageServiceRange | undefined {
  const item = record(value);
  const start = position(item?.start);
  const end = position(item?.end);
  const candidate = start && end ? { start, end } : undefined;
  return candidate && (text ? validRange(text, candidate) : comparePositions(candidate.start, candidate.end) <= 0)
    ? candidate
    : undefined;
}

function completionKind(value: unknown): LanguageServiceCompletionKind {
  return typeof value === "number" && value >= 1 && value <= 25
    ? completionKinds[value - 1] ?? "other"
    : "other";
}

function symbolKind(value: unknown): LanguageServiceCompletionKind {
  const kinds: Record<number, LanguageServiceCompletionKind> = {
    1: "file", 2: "module", 5: "class", 6: "method", 7: "property", 8: "field",
    9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable",
    14: "constant", 15: "text", 16: "value", 17: "value", 18: "value", 19: "value",
    20: "keyword", 21: "value", 22: "enum_member", 23: "struct", 24: "event",
    25: "operator", 26: "type_parameter"
  };
  return typeof value === "number" ? kinds[value] ?? "other" : "other";
}

function plainText(value: unknown, maxBytes: number): { value?: string; truncated: boolean } {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  else {
    const item = record(value);
    if (typeof item?.value === "string") raw = item.value;
  }
  if (raw === undefined) return { truncated: false };
  // Clients render this as inert text. Guessing which punctuation is markup
  // corrupts signatures and diagnostics; Markdown source is preserved literally.
  const clamped = clampUtf8(raw, maxBytes);
  return { value: clamped.value, truncated: clamped.truncated };
}

function documentation(value: unknown): { value?: string; truncated: boolean } {
  if (!Array.isArray(value)) return plainText(value, 16 * 1024);
  const joined = value.map((part) => plainText(part, 16 * 1024).value ?? "").filter(Boolean).join("\n");
  const clamped = clampUtf8(joined, 16 * 1024);
  return { value: clamped.value, truncated: clamped.truncated };
}

function normalizeCompletion(raw: unknown, text: string): { item?: LanguageServiceCompletion; truncated: boolean } {
  const item = record(raw);
  if (!item || typeof item.label !== "string") return { truncated: true };
  if (item.command !== undefined || item.additionalTextEdits !== undefined || item.insertTextFormat === 2) {
    return { truncated: true };
  }
  const label = clampUtf8(item.label, 256);
  const detail = plainText(item.detail, 4 * 1024);
  const docs = documentation(item.documentation);
  const insertText = typeof item.insertText === "string" ? clampUtf8(item.insertText, 256 * 1024) : undefined;
  if (insertText?.truncated || (item.insertText !== undefined && !insertText)) return { truncated: true };
  let textEdit: LanguageServiceCompletion["textEdit"];
  const rawEdit = record(item.textEdit);
  const editRange = range(rawEdit?.range, text);
  if (rawEdit && editRange && typeof rawEdit.newText === "string") {
    const newText = clampUtf8(rawEdit.newText, 256 * 1024);
    textEdit = { range: editRange, newText: newText.value };
    if (newText.truncated) return { truncated: true };
  }
  return {
    item: {
      label: label.value,
      kind: completionKind(item.kind),
      ...(detail.value ? { detail: detail.value } : {}),
      ...(docs.value ? { documentation: docs.value } : {}),
      ...(insertText ? { insertText: insertText.value } : {}),
      ...(textEdit ? { textEdit } : {})
    },
    truncated: label.truncated || detail.truncated || docs.truncated || (rawEdit !== undefined && !textEdit)
  };
}

function normalizeCompletions(raw: unknown, text: string): LanguageServiceFeatureResult {
  const source = Array.isArray(raw) ? raw : Array.isArray(record(raw)?.items) ? record(raw)?.items as unknown[] : [];
  const items: LanguageServiceCompletion[] = [];
  let truncated = source.length > 200;
  for (const candidate of source) {
    const normalized = normalizeCompletion(candidate, text);
    truncated ||= normalized.truncated;
    if (normalized.item && items.length < 200) items.push(normalized.item);
    else if (normalized.item) truncated = true;
  }
  return { kind: "completion", items, truncated };
}

function normalizeHover(raw: unknown, text: string): LanguageServiceFeatureResult {
  const item = record(raw);
  if (!item) return { kind: "hover", hover: null, truncated: false };
  const contents = documentation(item.contents);
  if (contents.value === undefined) return { kind: "hover", hover: null, truncated: true };
  const hoverRange = range(item.range, text);
  const hover: LanguageServiceHover = {
    contents: contents.value,
    ...(hoverRange ? { range: hoverRange } : {})
  };
  return { kind: "hover", hover, truncated: contents.truncated || (item.range !== undefined && !hover.range) };
}

async function definitionLocation(
  raw: unknown,
  workspaceRoot: string
): Promise<LanguageServiceDefinition | undefined> {
  const item = record(raw);
  const uri = typeof item?.uri === "string" ? item.uri : typeof item?.targetUri === "string" ? item.targetUri : undefined;
  const locationRange = range(item?.range ?? item?.targetSelectionRange ?? item?.targetRange);
  if (!uri || !locationRange || !uri.startsWith("file:")) return undefined;
  try {
    const requested = fileURLToPath(uri);
    const absolute = await realpath(requested);
    if (!isInside(workspaceRoot, absolute)) return undefined;
    // Prefer the server's lexical path when it is already under the canonical
    // root so an in-workspace symlink alias is visible and rejectable. macOS
    // may spell the same temp root as /var vs /private/var, so a system-level
    // alias outside that lexical form falls back to the proven real path.
    const requestedRelative = relative(workspaceRoot, isInside(workspaceRoot, requested) ? requested : absolute);
    let cursor = workspaceRoot;
    for (const segment of requestedRelative.split(/[\\/]+/).filter(Boolean)) {
      cursor = join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) return undefined;
    }
    if (!isInside(workspaceRoot, absolute) || !(await lstat(absolute)).isFile()) return undefined;
    const path = relative(workspaceRoot, absolute).split("\\").join("/");
    if (!indexableRelativePath(path) || Buffer.byteLength(path, "utf8") > 1024) return undefined;
    return { path, range: locationRange };
  } catch {
    return undefined;
  }
}

async function normalizeDefinitions(raw: unknown, workspaceRoot: string): Promise<LanguageServiceFeatureResult> {
  const source = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const locations: LanguageServiceDefinition[] = [];
  const candidates = source.slice(0, 200);
  let truncated = source.length > candidates.length;
  for (const candidate of candidates) {
    const normalized = await definitionLocation(candidate, workspaceRoot);
    if (!normalized) {
      truncated = true;
    } else if (locations.length < 20) {
      locations.push(normalized);
    } else {
      truncated = true;
      break;
    }
  }
  return { kind: "definition", locations, truncated };
}

function normalizeSymbol(
  raw: unknown,
  text: string,
  depth: number,
  budget: { remaining: number; truncated: boolean }
): LanguageServiceDocumentSymbol | undefined {
  if (depth > 16 || budget.remaining <= 0) {
    budget.truncated = true;
    return undefined;
  }
  const item = record(raw);
  const locationRange = item?.location ? record(item.location)?.range : undefined;
  const symbolRange = range(item?.range ?? locationRange, text);
  const selectionRange = range(item?.selectionRange, text) ?? symbolRange;
  if (!item || typeof item.name !== "string" || !symbolRange || !selectionRange) {
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= 1;
  const name = clampUtf8(item.name, 256);
  budget.truncated ||= name.truncated;
  const children = Array.isArray(item.children)
    ? item.children.flatMap((child) => {
      const normalized = normalizeSymbol(child, text, depth + 1, budget);
      return normalized ? [normalized] : [];
    })
    : [];
  return { name: name.value, kind: symbolKind(item.kind), range: symbolRange, selectionRange, children };
}

function normalizeSymbols(raw: unknown, text: string): LanguageServiceFeatureResult {
  const source = Array.isArray(raw) ? raw : [];
  const budget = { remaining: 1_000, truncated: false };
  const symbols = source.flatMap((item) => {
    const normalized = normalizeSymbol(item, text, 1, budget);
    return normalized ? [normalized] : [];
  });
  return { kind: "document_symbols", symbols, truncated: budget.truncated };
}

function normalizeSemanticTokens(raw: unknown): LanguageServiceFeatureResult {
  const source = record(raw)?.data;
  if (!Array.isArray(source)) return { kind: "semantic_tokens", tokens: { data: [] }, truncated: true };
  const data: number[] = [];
  let truncated = source.length % 5 !== 0;
  for (let index = 0; index + 4 < source.length; index += 5) {
    const group = source.slice(index, index + 5);
    if (!group.every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) {
      truncated = true;
      continue;
    }
    if (data.length >= 100_000) {
      truncated = true;
      break;
    }
    data.push(...group as number[]);
  }
  return {
    kind: "semantic_tokens",
    tokens: { data },
    truncated
  };
}

export async function normalizeFeatureResult(
  kind: LanguageServiceFeatureKind,
  raw: unknown,
  context: { text: string; workspaceRoot: string }
): Promise<LanguageServiceFeatureResult> {
  switch (kind) {
    case "completion": return normalizeCompletions(raw, context.text);
    case "hover": return normalizeHover(raw, context.text);
    case "definition": return normalizeDefinitions(raw, context.workspaceRoot);
    case "document_symbols": return normalizeSymbols(raw, context.text);
    case "semantic_tokens": return normalizeSemanticTokens(raw);
  }
}

export function normalizeDiagnostics(raw: unknown, text: string): { diagnostics: LanguageServiceDiagnostic[]; truncated: boolean } {
  const source = Array.isArray(record(raw)?.diagnostics) ? record(raw)?.diagnostics as unknown[] : [];
  const diagnostics: LanguageServiceDiagnostic[] = [];
  let truncated = source.length > 500;
  for (const candidate of source.slice(0, 500)) {
    const item = record(candidate);
    const diagnosticRange = range(item?.range, text);
    if (!item || !diagnosticRange || typeof item.message !== "string") {
      truncated = true;
      continue;
    }
    const message = plainText(item.message, 4 * 1024);
    const sourceText = typeof item.source === "string" ? clampUtf8(item.source, 128) : undefined;
    const rawCode = typeof item.code === "number" || typeof item.code === "string" ? String(item.code) : undefined;
    const code = rawCode ? clampUtf8(rawCode, 128) : undefined;
    const severity = item.severity === 1 ? "error" : item.severity === 2 ? "warning"
      : item.severity === 4 ? "hint" : "information";
    diagnostics.push({
      range: diagnosticRange,
      message: message.value ?? "",
      severity,
      ...(sourceText?.value ? { source: sourceText.value } : {}),
      ...(code?.value ? { code: code.value } : {})
    });
    truncated ||= message.truncated || sourceText?.truncated === true || code?.truncated === true;
  }
  return { diagnostics, truncated };
}
