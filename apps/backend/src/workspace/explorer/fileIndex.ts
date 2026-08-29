import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { WorkspaceFileIndexEntry } from "../../domain/models";
import type { LocalWorkspaceRegistry } from "../LocalWorkspaceRegistry";
import { isHiddenEntryName, isPreviewableName, maxWriteBytes } from "./bounds";
import { compareDirents, indexableRelativePath, joinWorkspacePath, safeRealpath } from "./paths";

// --- Bounded workspace file index --------------------------------------------
// One enumeration backs both the quick-open/`@`-mention file list and the
// "search in all files" route, cached per workspace for a short TTL so a client
// typing into either surface does not re-enumerate (or re-fork git) per
// keystroke. Every path that leaves the index passes exactly the tree read's
// filters: lexical bounding, secret names, generated directories, and symlink
// containment.
const maxIndexPaths = 20_000;
const fileIndexTtlMs = 15_000;
const maxIndexWalkDepth = 12;

export interface WorkspaceFileIndex {
  paths: string[];
  truncated: boolean;
  source: "git" | "walk";
}

/** The registry surface the index needs: one fixed, read-only enumeration. */
type FileIndexRegistry = Pick<LocalWorkspaceRegistry, "gitListFiles">;

/**
 * Short-TTL per-workspace path index with single-flight builds. Concurrent
 * misses share one build (a client typing hits both routes at once) instead of
 * racing duplicate enumerations, and an invalidation detaches an in-flight
 * build so a snapshot taken before a write or a checkout is never cached.
 */
export class WorkspaceFileIndexCache {
  private readonly cache = new Map<string, { index: WorkspaceFileIndex; atMs: number }>();
  // In-flight index builds, single-flight per workspace. An invalidation marks
  // the entry superseded and detaches it, so its result is neither cached nor
  // joined by later requests; entries live only as long as their build.
  private readonly inFlight = new Map<string, { promise: Promise<WorkspaceFileIndex>; supersede: () => void }>();

  constructor(private readonly registry: FileIndexRegistry) {}

  async get(workspaceId: string, workspaceRoot: string): Promise<WorkspaceFileIndex> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() - cached.atMs < fileIndexTtlMs) return cached.index;
    const inFlight = this.inFlight.get(workspaceId);
    if (inFlight) return inFlight.promise;

    const startedAtMs = Date.now();
    let superseded = false;
    const promise = this.build(workspaceId, workspaceRoot)
      .then((index) => {
        // An invalidation that landed while this build was in flight wins:
        // caching a snapshot taken before the write/checkout would resurrect
        // stale paths for a full TTL.
        if (!superseded) {
          this.cache.set(workspaceId, { index, atMs: startedAtMs });
        }
        return index;
      })
      .finally(() => {
        // A superseded build was already detached and a fresh build may have
        // taken the slot since, so only clear a slot this build still owns.
        if (this.inFlight.get(workspaceId)?.promise === promise) {
          this.inFlight.delete(workspaceId);
        }
      });
    this.inFlight.set(workspaceId, {
      promise,
      supersede: () => {
        superseded = true;
      }
    });
    return promise;
  }

  /**
   * Explicit invalidation seam for the paths that change what the index should
   * contain (a bounded write that creates a path, a rename, a deletion, a
   * branch switch) and for releasing a workspace's slot entirely
   * (unregistration). Without an argument it drops every workspace's index.
   */
  invalidate(workspaceId?: string): void {
    if (workspaceId === undefined) {
      this.cache.clear();
      for (const entry of this.inFlight.values()) {
        entry.supersede();
      }
      this.inFlight.clear();
      return;
    }
    this.cache.delete(workspaceId);
    const inFlight = this.inFlight.get(workspaceId);
    if (inFlight) {
      inFlight.supersede();
      this.inFlight.delete(workspaceId);
    }
  }

  private async build(workspaceId: string, workspaceRoot: string): Promise<WorkspaceFileIndex> {
    // Git workspaces enumerate through `git ls-files`, which respects
    // `.gitignore` for free; anything else (including a workspace whose git
    // invocation failed) falls back to the bounded walk below.
    const listed = await this.registry.gitListFiles(workspaceId, maxIndexPaths);
    if (!listed.isRepository) return walkWorkspaceFiles(workspaceRoot);

    const paths: string[] = [];
    for (const rawPath of listed.paths) {
      const safePath = indexableRelativePath(rawPath);
      if (safePath) paths.push(safePath);
    }
    return { paths: sortPaths(paths), truncated: listed.truncated, source: "git" };
  }
}

// Bounded filesystem enumeration for non-git workspaces. Reuses the tree
// read's hidden-name filtering, and — like git's enumeration — never descends
// through a symlinked directory (a link back to an ancestor would otherwise
// cycle). A contained symlink to a file is indexed as a leaf, matching what the
// tree read and file preview already expose; an escaping link is skipped, never
// followed.
async function walkWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFileIndex> {
  const paths: string[] = [];
  const queue: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: workspaceRoot, relativePath: "", depth: 0 }
  ];
  let truncated = false;
  let capReached = false;
  for (let cursor = 0; cursor < queue.length && !capReached; cursor += 1) {
    const current = queue[cursor];
    let dirents;
    try {
      dirents = await readdir(current.directoryPath, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is an ordinary "nothing here" state
    }
    for (const dirent of dirents.sort(compareDirents)) {
      if (paths.length >= maxIndexPaths) {
        truncated = true;
        capReached = true;
        break;
      }
      if (isHiddenEntryName(dirent.name)) continue;
      const childRelativePath = joinWorkspacePath(current.relativePath, dirent.name);
      const childPath = join(current.directoryPath, dirent.name);
      if (dirent.isSymbolicLink()) {
        const childRealPath = await safeRealpath(workspaceRoot, childPath);
        if (!childRealPath) continue;
        let linkStat;
        try {
          linkStat = await stat(childRealPath);
        } catch {
          continue;
        }
        if (linkStat.isFile()) paths.push(childRelativePath);
        continue;
      }
      if (dirent.isDirectory()) {
        if (current.depth < maxIndexWalkDepth) {
          queue.push({ directoryPath: childPath, relativePath: childRelativePath, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (dirent.isFile()) paths.push(childRelativePath);
    }
  }
  return { paths: sortPaths(paths), truncated, source: "walk" };
}

// Point-of-use validation for an indexed path: full realpath containment (so
// a leaf or intermediate segment that became a symlink out of the workspace
// after the index was built is dropped rather than followed) plus the tree
// read's `previewable` contract.
export async function describeIndexedFile(
  workspaceRoot: string,
  safePath: string
): Promise<WorkspaceFileIndexEntry | undefined> {
  const targetPath = await safeRealpath(workspaceRoot, resolve(workspaceRoot, safePath));
  if (!targetPath) return undefined;
  let fileStat;
  try {
    fileStat = await stat(targetPath);
  } catch {
    return undefined;
  }
  if (!fileStat.isFile()) return undefined;
  const name = basename(safePath);
  return {
    path: safePath,
    name,
    previewable: isPreviewableName(name) && fileStat.size <= maxWriteBytes
  };
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}
