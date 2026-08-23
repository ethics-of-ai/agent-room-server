import type { CanonicalDiffFile } from "../AgentRunner";
import { nonnegativeIntegerValue, objectValue, stringValue } from "../shared/jsonValues";

const MAX_DIFF_FILES = 100;
// Unified diffs are input to the bounded per-file summary parser, not display
// text, so they get their own defensive ceiling rather than the canonical
// mapper's chat-text clamp.
const MAX_UNIFIED_DIFF_LENGTH = 1024 * 1024;

export interface CodexDiffSummary {
  files: CanonicalDiffFile[];
  truncated: boolean;
}

/**
 * Resolve the per-file diff summary from a Codex `turn/diff/updated` payload.
 * Newer Codex app-servers send a structured `files` array; codex-cli 0.142.5
 * sends only a single unified-diff string under `diff`, so parse the file
 * entries out of that when no structured array is present.
 *
 * This is Codex protocol knowledge and lives with the Codex adapter: the
 * canonical mapper is handed the resulting `CanonicalDiffFile[]` and never sees
 * either native shape.
 */
export function codexDiffSummary(content: Record<string, unknown>): CodexDiffSummary {
  const structured = structuredDiffFiles(content.files);
  if (structured.files.length > 0) return structured;
  const unified = unifiedDiffValue(content.diff);
  if (!unified) return structured;
  const parsed = diffFilesFromUnifiedDiff(unified.value);
  return {
    files: parsed.files,
    truncated: unified.truncated || parsed.truncated
  };
}

function structuredDiffFiles(value: unknown): CodexDiffSummary {
  if (!Array.isArray(value)) return { files: [], truncated: false };
  const files = value.slice(0, MAX_DIFF_FILES).flatMap((item) => {
    const object = objectValue(item);
    const path = stringValue(object?.path);
    const status = stringValue(object?.status);
    if (!path || !status) return [];
    const oldPath = stringValue(object?.oldPath);
    const additions = nonnegativeIntegerValue(object?.additions);
    const deletions = nonnegativeIntegerValue(object?.deletions);
    return [{
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {})
    }];
  });
  return { files, truncated: value.length > MAX_DIFF_FILES };
}

/**
 * Parse a git-style unified diff into per-file summaries. Recognizes the
 * `diff --git a/<path> b/<path>` file boundary, the `new file` / `deleted
 * file` / `rename` mode headers for status, and counts added/removed content
 * lines (excluding the `+++`/`---` file headers and hunk `@@` lines). Paths
 * are taken from the `b/` side (the `a/` side for deletions) with the git
 * prefix stripped. Bounded to `MAX_DIFF_FILES` like the structured path.
 */
function diffFilesFromUnifiedDiff(diff: string): CodexDiffSummary {
  const files: CanonicalDiffFile[] = [];
  let current: { path: string; oldPath?: string; status: string; additions: number; deletions: number } | undefined;
  let inHunk = false;
  let truncated = false;

  const flush = () => {
    if (!current || !current.path) return;
    files.push({
      path: current.path,
      ...(current.oldPath ? { oldPath: current.oldPath } : {}),
      status: current.status,
      additions: current.additions,
      deletions: current.deletions
    });
    current = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
      const path = diffGitDestinationPath(line) ?? "";
      current = { path, status: "modified", additions: 0, deletions: 0 };
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      current.additions += 1;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions += 1;
    } else if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from")) {
      current.status = "renamed";
      // A rename's source is gone from disk, so it is worth carrying. A copy's
      // source (below) still exists and deliberately never becomes oldPath.
      const path = gitHeaderPath(line.slice("rename from".length));
      if (path) current.oldPath = path;
    } else if (line.startsWith("copy from")) {
      current.status = "renamed";
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      current.status = "renamed";
      const path = gitHeaderPath(line.slice(line.indexOf(" to ") + 4));
      if (path) current.path = path;
    } else if (line.startsWith("+++ ")) {
      const path = gitHeaderPath(line.slice(4));
      if (path && path !== "/dev/null") current.path = path;
    } else if (line.startsWith("--- ")) {
      // Only source of a real path for a deletion, whose `+++` is /dev/null.
      const path = gitHeaderPath(line.slice(4));
      if (path && path !== "/dev/null" && (!current.path || current.status === "deleted")) current.path = path;
    }
  }
  flush();
  return { files: files.slice(0, MAX_DIFF_FILES), truncated };
}

function unifiedDiffValue(value: unknown): { value: string; truncated: boolean } | undefined {
  return typeof value === "string" && value.length > 0
    ? {
        value: value.slice(0, MAX_UNIFIED_DIFF_LENGTH),
        truncated: value.length > MAX_UNIFIED_DIFF_LENGTH
      }
    : undefined;
}

function diffGitDestinationPath(line: string): string | undefined {
  const body = line.slice("diff --git".length);
  // Git does not quote paths merely for containing spaces, so the whitespace
  // token parse below would split them. Every non-rename section uses the
  // same-path form `a/P b/P` — including binary and mode-only files, which
  // never emit the correcting `---`/`+++` headers — so recover P by finding
  // the split where both halves match. Renamed paths with spaces still fall
  // through to the token parse; their `rename to` header supplies the path.
  const samePath = samePathFromSpacedDiffGitBody(body);
  if (samePath !== undefined) return samePath;
  const source = gitPathToken(body, 0);
  if (!source) return undefined;
  const destination = gitPathToken(body, source.end);
  return destination ? stripGitPrefix(destination.value) : stripGitPrefix(source.value);
}

function samePathFromSpacedDiffGitBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("a/")) return undefined;
  const rest = trimmed.slice(2);
  for (let index = rest.indexOf(" b/"); index !== -1; index = rest.indexOf(" b/", index + 1)) {
    if (rest.slice(0, index) === rest.slice(index + 3)) {
      return rest.slice(0, index);
    }
  }
  return undefined;
}

function gitHeaderPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"")) {
    return stripGitPrefix(gitPathToken(trimmed, 0)?.value ?? "");
  }
  // Traditional unified-diff timestamps are tab-separated. Spaces are valid
  // path characters and must otherwise be retained.
  return stripGitPrefix(trimmed.split("\t", 1)[0] ?? "");
}

function stripGitPrefix(value: string): string {
  return value.replace(/^[ab]\//, "");
}

function gitPathToken(input: string, start: number): { value: string; end: number } | undefined {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
  if (index >= input.length) return undefined;

  if (input[index] !== "\"") {
    const tokenStart = index;
    while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
    return { value: input.slice(tokenStart, index), end: index };
  }

  const tokenStart = index;
  index += 1;
  let escaped = false;
  while (index < input.length) {
    const character = input[index];
    if (!escaped && character === "\"") {
      const token = input.slice(tokenStart, index + 1);
      return { value: decodeGitQuotedPath(token), end: index + 1 };
    }
    if (!escaped && character === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
    index += 1;
  }
  return undefined;
}

function decodeGitQuotedPath(token: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const appendText = (value: string) => bytes.push(...encoder.encode(value));

  for (let index = 1; index < token.length - 1; index += 1) {
    const character = token[index] ?? "";
    if (character !== "\\") {
      const codePoint = token.codePointAt(index);
      if (codePoint === undefined) continue;
      appendText(String.fromCodePoint(codePoint));
      if (codePoint > 0xffff) index += 1;
      continue;
    }

    const escaped = token[index + 1];
    if (escaped === undefined) break;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      let offset = index + 2;
      while (octal.length < 3 && offset < token.length - 1 && /[0-7]/.test(token[offset] ?? "")) {
        octal += token[offset];
        offset += 1;
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
      continue;
    }

    const escapeBytes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13
    };
    const byte = escapeBytes[escaped];
    if (byte !== undefined) {
      bytes.push(byte);
    } else {
      appendText(escaped);
    }
    index += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
