import type { WorkspaceFileIndexEntry, WorkspaceFileIndexSnapshot } from "../../domain/models";
import { clampLimit } from "./bounds";
import { describeIndexedFile, type WorkspaceFileIndex } from "./fileIndex";
import type { WorkspaceTarget } from "./paths";

/** Upper bound on `limit` for the file-index route. */
export const maxFileIndexResults = 200;
const defaultFileIndexResults = 50;

/**
 * The ranked quick-open / `@`-mention listing. Ranking happens over the cached
 * enumeration; only the top `limit` paths are stat'd, and each one is
 * re-checked for containment before it is returned, so an escaping symlink is
 * skipped, never followed.
 */
export async function listIndexedFiles(
  target: WorkspaceTarget,
  index: WorkspaceFileIndex,
  input: { query?: string; limit?: number }
): Promise<WorkspaceFileIndexSnapshot> {
  const query = (input.query ?? "").trim();
  const limit = clampLimit(input.limit ?? defaultFileIndexResults, maxFileIndexResults);
  const ranked = rankIndexPaths(index.paths, query);
  const files: WorkspaceFileIndexEntry[] = [];
  // Probing is bounded as well as the result count: a stale index (files
  // deleted since it was built, or a directory full of escaping symlinks)
  // must not turn one request into an unbounded run of realpath syscalls.
  const maxProbes = limit * 4 + 25;
  let examined = 0;
  for (const path of ranked) {
    if (files.length >= limit || examined >= maxProbes) break;
    examined += 1;
    const entry = await describeIndexedFile(target.workspaceRoot, path);
    if (entry) files.push(entry);
  }
  return {
    workspaceId: target.workspaceId,
    query,
    files,
    truncated: index.truncated || examined < ranked.length
  };
}

// Server-side ranking for quick-open / `@` mention lists. Tiers, best first:
// exact basename, basename prefix, basename substring, path substring,
// subsequence ("fuzzy") over the path. Ties break on shorter path, then
// alphabetically, so the result order is stable for a given index.
function rankIndexPaths(paths: string[], query: string): string[] {
  if (!query) {
    return [...paths].sort(compareRankedPaths);
  }
  const needle = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const score = scoreIndexPath(path, needle);
    if (score !== undefined) scored.push({ path, score });
  }
  return scored
    .sort((left, right) => (left.score !== right.score ? left.score - right.score : compareRankedPaths(left.path, right.path)))
    .map((entry) => entry.path);
}

function compareRankedPaths(left: string, right: string): number {
  return left.length !== right.length ? left.length - right.length : left.localeCompare(right);
}

function scoreIndexPath(path: string, needle: string): number | undefined {
  const lowerPath = path.toLowerCase();
  const lowerName = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (lowerName === needle) return 0;
  if (lowerName.startsWith(needle)) return 1;
  if (lowerName.includes(needle)) return 2;
  if (lowerPath.includes(needle)) return 3;
  return isSubsequence(needle, lowerPath) ? 4 : undefined;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (let position = 0; position < haystack.length && index < needle.length; position += 1) {
    if (haystack[position] === needle[index]) index += 1;
  }
  return index === needle.length;
}
