import { indexableRelativePath } from "../WorkspaceExplorer";
import { WorkspaceGitServiceError } from "./errors";
import { isRenamedEntry, isUntrackedEntry, type GitChangedEntry } from "./statusParsing";
import type { GitStagedPath } from "../LocalWorkspaceGit";

/**
 * Which paths a fixed Git operation is allowed to act on. Every path here
 * passes `indexableRelativePath` — the same filter the tree read and the file
 * index use — because staging is the step before exfiltration: a secret-named
 * or generated path that cannot be listed must also be one AgentRoom cannot
 * commit. See `docs/safety/TRUST_AND_SAFETY.md` (Git operations).
 */
export interface ResolvedPaths {
  accepted: string[];
  skipped: string[];
}

export function resolveExplicitPaths(paths: string[] | undefined): ResolvedPaths {
  if (!paths || paths.length === 0) {
    throw new WorkspaceGitServiceError("At least one workspace-relative path is required");
  }
  const accepted: string[] = [];
  for (const raw of paths) {
    const safePath = indexableRelativePath(raw);
    // Explicitly named paths are all-or-nothing: silently dropping one would let
    // a client believe it staged or discarded something it did not.
    if (!safePath) {
      throw new WorkspaceGitServiceError(
        "Path is outside the workspace, secret-named, or in a generated directory",
        415
      );
    }
    accepted.push(safePath);
  }
  return { accepted: [...new Set(accepted)], skipped: [] };
}

/**
 * Every changed path git reports, filtered through the shared workspace path
 * filter. The caller reads the entries from an uncapped porcelain status rather
 * than the 200-file status projection, so "stage all" cannot silently miss
 * files in a very dirty tree.
 */
export function selectAllChangedPaths(
  entries: GitChangedEntry[],
  predicate?: (entry: GitChangedEntry) => boolean
): ResolvedPaths {
  const accepted: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (predicate && !predicate(entry)) continue;
    // A rename's original path has to move too, or staging the pair leaves the
    // deletion behind.
    for (const candidate of renamePair(entry)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const safePath = indexableRelativePath(candidate);
      if (safePath) accepted.push(safePath);
      else skipped.push(candidate);
    }
  }
  return { accepted, skipped };
}

/**
 * Resolves caller-supplied paths against Git's exact changed-file entries.
 * Merely passing the lexical filter is insufficient: `git add src` recurses
 * through a directory and could otherwise stage a refused `src/.env` below
 * it. Expanding renames here also keeps both sides of the change together.
 *
 * `readEntries` is taken lazily so a request naming no path — or a refused one
 * — is rejected before the backend forks git at all.
 */
export async function selectExplicitChangedPaths(
  paths: string[] | undefined,
  readEntries: () => Promise<GitChangedEntry[]>,
  predicate?: (entry: GitChangedEntry) => boolean
): Promise<ResolvedPaths> {
  const resolved = resolveExplicitPaths(paths);
  const byPath = indexEntriesByPath(await readEntries());

  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const requestedPath of resolved.accepted) {
    const entry = byPath.get(requestedPath);
    if (!entry || (predicate && !predicate(entry))) {
      throw new WorkspaceGitServiceError("Path is not an eligible changed file", 409);
    }
    for (const candidate of renamePair(entry)) {
      if (seen.has(candidate)) continue;
      const safePath = indexableRelativePath(candidate);
      if (!safePath) {
        throw new WorkspaceGitServiceError(
          "Changed path is outside the workspace, secret-named, or in a generated directory",
          415
        );
      }
      seen.add(candidate);
      accepted.push(safePath);
    }
  }
  return { accepted, skipped: [] };
}

/**
 * `git commit` records the repository's entire index, including paths staged
 * outside AgentRoom and paths outside a registered subdirectory, so the
 * complete staged set is re-checked immediately before committing.
 */
export function assertIndexableStagedPaths(paths: GitStagedPath[]): void {
  for (const candidate of paths) {
    if (!candidate.withinWorkspace || !indexableRelativePath(candidate.path)) {
      throw new WorkspaceGitServiceError(
        "Git index contains a path outside the workspace, secret-named, or in a generated directory; unstage it before committing",
        415
      );
    }
  }
}

/** The three fixed commands a discard resolves to, per named path. */
export interface DiscardPlan {
  restore: string[];
  unstage: string[];
  remove: string[];
}

/**
 * Classifies each named path by what "revert to HEAD" means for it. The
 * distinction is entirely in the porcelain status letters: a path HEAD does not
 * have is deleted rather than restored, and a staged rename is two paths.
 */
export function planDiscardOperations(entries: GitChangedEntry[], paths: string[]): DiscardPlan {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const plan: DiscardPlan = { restore: [], unstage: [], remove: [] };

  for (const path of paths) {
    const entry = byPath.get(path);
    // A path with no pending change has nothing to discard; treat it as a
    // no-op rather than an error so a stale client list stays harmless.
    if (!entry) continue;
    if (isUntrackedEntry(entry)) {
      // Never entered the index, so `clean` alone removes it. Unstaging it
      // would fail the whole batch on a pathspec git does not know.
      plan.remove.push(path);
      continue;
    }
    if (entry.oldPath && isRenamedEntry(entry)) {
      // A staged rename is two paths: bring the original back from HEAD and
      // drop the new one, which HEAD does not have.
      plan.restore.push(entry.oldPath);
      plan.unstage.push(path);
      plan.remove.push(path);
      continue;
    }
    if (entry.indexStatus === "A") {
      // Added to the index but absent from HEAD, so "revert to HEAD" means
      // unstaging it and deleting the file.
      plan.unstage.push(path);
      plan.remove.push(path);
      continue;
    }
    plan.restore.push(path);
  }
  return plan;
}

function renamePair(entry: GitChangedEntry): string[] {
  return entry.oldPath ? [entry.path, entry.oldPath] : [entry.path];
}

function indexEntriesByPath(entries: GitChangedEntry[]): Map<string, GitChangedEntry> {
  const byPath = new Map<string, GitChangedEntry>();
  for (const entry of entries) {
    byPath.set(entry.path, entry);
    if (entry.oldPath) byPath.set(entry.oldPath, entry);
  }
  return byPath;
}
