import type {
  LocalWorkspaceGitBranch,
  LocalWorkspaceGitChangedFile,
  LocalWorkspaceGitFileStatus,
  LocalWorkspaceGitStatus
} from "../../domain/models";

// Everything here is a pure function of git's own output: the porcelain status,
// the numstat line counts, and `for-each-ref`'s tracking column. Keeping the
// parsing beside the projection it feeds is what lets the mutating operations
// and the read projection classify a path by the same status letters instead of
// each re-deriving them.

export const maxGitStatusFiles = 200;
const conflictStatusCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * One entry of the raw, uncapped porcelain status. The `status` route's
 * `LocalWorkspaceGitChangedFile` is the client-facing projection of this; the
 * mutating operations need the raw index/worktree status letters instead,
 * because "is this path in HEAD" is what decides whether discarding it means
 * restoring it or deleting it.
 */
export interface GitChangedEntry {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface ParsedNumstatFile {
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

export function parsePorcelainStatus(output: string): GitChangedEntry[] {
  const tokens = output.split("\0");
  const files: GitChangedEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4) continue;

    const indexStatus = token[0] ?? " ";
    const worktreeStatus = token[1] ?? " ";
    const path = token.slice(3);
    if (!path) continue;

    let oldPath: string | undefined;
    if (isRenameOrCopyStatus(indexStatus) || isRenameOrCopyStatus(worktreeStatus)) {
      oldPath = tokens[index + 1] || undefined;
      index += oldPath ? 1 : 0;
    }

    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      indexStatus,
      worktreeStatus
    });
  }
  return files;
}

/** The client-facing changed-file projection: porcelain entries plus line counts. */
export function gitStatusFiles(
  entries: GitChangedEntry[],
  unstagedNumstat: string,
  stagedNumstat: string
): LocalWorkspaceGitChangedFile[] {
  const files = new Map<string, LocalWorkspaceGitChangedFile>();

  for (const item of entries) {
    files.set(item.path, {
      path: item.path,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      status: statusFromCodes(item.indexStatus, item.worktreeStatus),
      staged: isStagedStatus(item.indexStatus),
      unstaged: isUnstagedStatus(item.worktreeStatus),
      ...lineCountsFor(undefined, undefined)
    });
  }

  for (const item of parseNumstat(unstagedNumstat)) {
    mergeNumstat(files, item, "unstaged");
  }
  for (const item of parseNumstat(stagedNumstat)) {
    mergeNumstat(files, item, "staged");
  }

  return [...files.values()]
    .map((file) => stripUndefinedCounts(file))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function gitStatusCounts(files: LocalWorkspaceGitChangedFile[]) {
  return {
    total: files.length,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged && file.status !== "untracked").length,
    untracked: files.filter((file) => file.status === "untracked").length,
    conflicts: files.filter((file) => file.status === "conflicted").length
  };
}

export function cleanNonRepositoryStatus(workspaceId: string): LocalWorkspaceGitStatus {
  return {
    workspaceId,
    isRepository: false,
    clean: true,
    counts: {
      total: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0
    },
    files: [],
    truncated: false,
    refreshedAt: new Date().toISOString()
  };
}

/** Repository-relative git output re-anchored to the registered subdirectory. */
export function workspaceRelativeGitPath(repositoryPath: string, prefix: string): string | undefined {
  if (!prefix) return repositoryPath || undefined;
  if (!repositoryPath.startsWith(prefix)) return undefined;
  return repositoryPath.slice(prefix.length) || undefined;
}

export function stripTrailingLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

// `%(upstream:track)` is empty for a branch with no upstream AND for one exactly
// in sync, so "has an upstream" is what separates "unknown" from "0 ahead, 0
// behind". `[gone]` means the upstream ref no longer exists.
export function parseUpstreamTrack(
  track: string,
  hasUpstream: boolean
): Pick<LocalWorkspaceGitBranch, "ahead" | "behind" | "upstreamGone"> {
  if (!hasUpstream) return {};
  if (track.includes("gone")) return { upstreamGone: true };
  const ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? "0", 10);
  const behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? "0", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  };
}

// Entry-level porcelain predicates. Exported so the mutating operations classify
// a changed path by exactly the same status-letter rules the read projection
// uses, instead of re-deriving them and drifting.
export function isStagedEntry(entry: GitChangedEntry): boolean {
  return isStagedStatus(entry.indexStatus);
}

export function isUntrackedEntry(entry: GitChangedEntry): boolean {
  return entry.indexStatus === "?" && entry.worktreeStatus === "?";
}

export function isRenamedEntry(entry: GitChangedEntry): boolean {
  return isRenameOrCopyStatus(entry.indexStatus) || isRenameOrCopyStatus(entry.worktreeStatus);
}

function parseNumstat(output: string): ParsedNumstatFile[] {
  const tokens = output.split("\0");
  const files: ParsedNumstatFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumstatCount(parts[0]);
    const deletions = parseNumstatCount(parts[1]);
    let path = parts.slice(2).join("\t");
    let oldPath: string | undefined;

    if (!path) {
      oldPath = tokens[index + 1] || undefined;
      path = tokens[index + 2] || "";
      index += path ? 2 : 0;
    }

    if (!path) continue;
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      ...lineCountsFor(additions, deletions)
    });
  }
  return files;
}

function mergeNumstat(
  files: Map<string, LocalWorkspaceGitChangedFile>,
  item: ParsedNumstatFile,
  scope: "staged" | "unstaged"
): void {
  const existing = files.get(item.path) ?? {
    path: item.path,
    status: item.oldPath ? "renamed" : "modified",
    staged: false,
    unstaged: false
  } satisfies LocalWorkspaceGitChangedFile;

  files.set(item.path, stripUndefinedCounts({
    ...existing,
    ...(item.oldPath && !existing.oldPath ? { oldPath: item.oldPath } : {}),
    staged: existing.staged || scope === "staged",
    unstaged: existing.unstaged || scope === "unstaged",
    additions: sumOptional(existing.additions, item.additions),
    deletions: sumOptional(existing.deletions, item.deletions)
  }));
}

function statusFromCodes(indexStatus: string, worktreeStatus: string): LocalWorkspaceGitFileStatus {
  if (conflictStatusCodes.has(`${indexStatus}${worktreeStatus}`)) return "conflicted";
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (isRenameOrCopyStatus(indexStatus) || isRenameOrCopyStatus(worktreeStatus)) {
    return indexStatus === "C" || worktreeStatus === "C" ? "copied" : "renamed";
  }
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "T" || worktreeStatus === "T") return "type_changed";
  return "modified";
}

function isStagedStatus(status: string): boolean {
  return status !== " " && status !== "?" && status !== "!";
}

function isUnstagedStatus(status: string): boolean {
  return status !== " " && status !== "!";
}

function isRenameOrCopyStatus(status: string): boolean {
  return status === "R" || status === "C";
}

function parseNumstatCount(value: string | undefined): number | undefined {
  if (!value || value === "-") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function lineCountsFor(
  additions: number | undefined,
  deletions: number | undefined
): Pick<LocalWorkspaceGitChangedFile, "additions" | "deletions"> {
  return {
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {})
  };
}

function stripUndefinedCounts(file: LocalWorkspaceGitChangedFile): LocalWorkspaceGitChangedFile {
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    staged: file.staged,
    unstaged: file.unstaged,
    ...lineCountsFor(file.additions, file.deletions)
  };
}
