import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { WorkspaceSearchFileMatches, WorkspaceSearchMatch, WorkspaceSearchSnapshot } from "../../domain/models";
import { clampLimit, isPreviewableName, maxWriteBytes } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import type { WorkspaceFileIndex } from "./fileIndex";
import { readFileHead } from "./filePreview";
import { safeRealpath, type WorkspaceTarget } from "./paths";

/** Upper bound on `limit` (total matches) for the content-search route. */
export const maxSearchMatches = 500;
const maxSearchFilesScanned = 2000;
const maxSearchMatchesPerFile = 20;
const searchBudgetMs = 3000;
// Per-file read cap for search; the same 256 KB ceiling the read/write path uses.
const maxSearchFileBytes = maxWriteBytes;
const maxSearchPreviewChars = 200;
const maxIncludePatternChars = 200;
const wordCharacterPattern = /[\p{L}\p{N}_]/u;

/**
 * Bounded, read-only literal-substring content search over the cached index.
 * Deliberately not a regex search: a caller-supplied pattern would be an
 * in-process ReDoS vector, so this exposes only literal matching with
 * `matchCase`/`wholeWord`/`include` toggles. Every bound (files scanned,
 * matches per file, total matches, bytes per file, wall clock) reports partial
 * results through a `truncated` flag rather than running long.
 */
export async function searchIndexedFiles(
  target: WorkspaceTarget,
  index: WorkspaceFileIndex,
  input: { query: string; matchCase?: boolean; wholeWord?: boolean; include?: string; limit?: number }
): Promise<WorkspaceSearchSnapshot> {
  const query = input.query.trim();
  if (!query) {
    throw new WorkspaceExplorerError("Workspace search query is required");
  }
  const limit = clampLimit(input.limit ?? maxSearchMatches, maxSearchMatches);
  const include = input.include?.trim().slice(0, maxIncludePatternChars) || undefined;
  const deadlineMs = Date.now() + searchBudgetMs;

  const files: WorkspaceSearchFileMatches[] = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let truncated = index.truncated;

  for (let position = 0; position < index.paths.length; position += 1) {
    if (totalMatches >= limit || filesScanned >= maxSearchFilesScanned || Date.now() >= deadlineMs) {
      // Any remaining candidate could still have matched, so report partial results.
      truncated = truncated || position < index.paths.length;
      break;
    }
    const path = index.paths[position];
    if (include && !matchesIncludePattern(path, include)) continue;

    const file = await readSearchableFile(target.workspaceRoot, path);
    if (!file.opened) continue;
    filesScanned += 1;
    if (file.content === undefined) continue; // binary: read, then skipped

    const remaining = Math.min(maxSearchMatchesPerFile, limit - totalMatches);
    const found = findFileMatches(file.content, query, {
      matchCase: input.matchCase ?? false,
      wholeWord: input.wholeWord ?? false,
      maxMatches: remaining
    });
    if (found.matches.length === 0) continue;
    totalMatches += found.matches.length;
    files.push({ path, matches: found.matches, truncated: found.truncated || file.truncated });
  }

  return { workspaceId: target.workspaceId, query, files, totalMatches, filesScanned, truncated };
}

// Bounded search read of one indexed file. Shares the preview path's
// containment, secret-name refusal, byte cap, and NUL/binary contract.
// `opened` distinguishes "counted against the scan budget" from "skipped
// before any read"; `content` is absent for a binary file.
async function readSearchableFile(
  workspaceRoot: string,
  safePath: string
): Promise<{ opened: boolean; content?: string; truncated: boolean }> {
  const name = basename(safePath);
  if (!isPreviewableName(name)) return { opened: false, truncated: false };
  const targetPath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, safePath));
  if (!targetPath) return { opened: false, truncated: false };
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    return { opened: false, truncated: false };
  }
  if (!fileStat.isFile()) return { opened: false, truncated: false };

  let buffer: Buffer;
  try {
    buffer = await readFileHead(targetPath, Math.min(fileStat.size, maxSearchFileBytes));
  } catch {
    return { opened: false, truncated: false };
  }
  if (buffer.includes(0)) return { opened: true, truncated: false }; // binary: scanned, not searched
  return { opened: true, content: buffer.toString("utf8"), truncated: fileStat.size > maxSearchFileBytes };
}

// Optional `include` filter for the content search. Deliberately not a regex:
// `*` matches any run of characters (including `/`), `?` matches one, and there
// is no `*`/`**` distinction. A pattern with no wildcard is a path-prefix (or
// basename) filter. Matching is case-insensitive and runs through the linear
// two-pointer matcher below, so no caller-supplied string ever becomes a regex.
function matchesIncludePattern(path: string, pattern: string): boolean {
  const lowerPath = path.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const lowerName = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (!lowerPattern.includes("*") && !lowerPattern.includes("?")) {
    return (
      lowerPath === lowerPattern ||
      lowerPath.startsWith(`${lowerPattern}/`) ||
      (!lowerPattern.includes("/") && lowerName === lowerPattern)
    );
  }
  return wildcardMatch(lowerPattern.includes("/") ? lowerPath : lowerName, lowerPattern);
}

// Classic iterative wildcard match: O(text * pattern) worst case with no
// recursion and no regex engine, so a hostile pattern cannot blow up the event
// loop the way a caller-supplied regex could.
function wildcardMatch(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === text[textIndex])) {
      textIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

// Literal substring matching, line by line. Line and column are 1-indexed
// (Monaco convention) and column/length are UTF-16 code-unit offsets into the
// matched line.
function findFileMatches(
  content: string,
  query: string,
  options: { matchCase: boolean; wholeWord: boolean; maxMatches: number }
): { matches: WorkspaceSearchMatch[]; truncated: boolean } {
  const matches: WorkspaceSearchMatch[] = [];
  if (options.maxMatches <= 0) return { matches, truncated: true };
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // Case-insensitive matching compares lowered copies, but a few code points
    // change length when lowered (e.g. U+0130), which would desync the offsets
    // reported against the original line. Fall back to exact matching for such
    // a line rather than report a wrong column.
    const loweredLine = options.matchCase ? line : line.toLowerCase();
    const caseInsensitive = !options.matchCase && loweredLine.length === line.length;
    const haystack = caseInsensitive ? loweredLine : line;
    const needle = caseInsensitive ? query.toLowerCase() : query;
    if (needle.length === 0) break;

    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      if (options.wholeWord && !isWholeWordMatch(line, at, needle.length)) continue;
      if (matches.length >= options.maxMatches) return { matches, truncated: true };
      matches.push({
        line: lineIndex + 1,
        column: at + 1,
        length: needle.length,
        ...boundedMatchPreview(line, at, needle.length)
      });
    }
  }
  return { matches, truncated: false };
}

function isWholeWordMatch(line: string, at: number, length: number): boolean {
  const before = at > 0 ? line[at - 1] : "";
  const after = at + length < line.length ? line[at + length] : "";
  return !wordCharacterPattern.test(before) && !wordCharacterPattern.test(after);
}

// The matched line, bounded to `maxSearchPreviewChars` centred on the match, so
// a minified or generated file cannot return a megabyte-long line. Also reports
// where the match sits inside the returned window for client-side highlighting.
// The window edges never split a surrogate pair — the preview shrinks by one
// UTF-16 unit per affected edge instead of carrying a lone surrogate a client
// would render as U+FFFD (the same code-point-boundary discipline as the
// artifact cap).
function boundedMatchPreview(line: string, at: number, length: number): { preview: string; previewColumn: number } {
  if (line.length <= maxSearchPreviewChars) {
    return { preview: line, previewColumn: at + 1 };
  }
  const lead = Math.max(0, Math.floor((maxSearchPreviewChars - Math.min(length, maxSearchPreviewChars)) / 2));
  let start = Math.max(0, at - lead);
  if (start + maxSearchPreviewChars > line.length) {
    start = Math.max(0, line.length - maxSearchPreviewChars);
  }
  if (splitsSurrogatePair(line, start)) start += 1;
  let end = Math.min(line.length, start + maxSearchPreviewChars);
  if (splitsSurrogatePair(line, end)) end -= 1;
  return {
    preview: line.slice(start, end),
    previewColumn: Math.max(1, at - start + 1)
  };
}

// True when `index` falls between the halves of a surrogate pair, so slicing
// there would produce a lone surrogate.
function splitsSurrogatePair(line: string, index: number): boolean {
  if (index <= 0 || index >= line.length) return false;
  const before = line.charCodeAt(index - 1);
  const after = line.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
