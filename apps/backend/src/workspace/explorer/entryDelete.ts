import { lstat, rm, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { WorkspaceExplorerError } from "./errors";
import { resolveMutableWorkspaceEntry } from "./entryMutation";
import type { WorkspaceTarget } from "./paths";
import { inspectBoundedSubtree } from "./subtree";

export interface WorkspaceFileDeleteResult {
  workspaceId: string;
  workspacePath: string;
  path: string;
  sizeBytes: number;
  deleted: true;
}

export interface WorkspaceDirectoryDeleteResult {
  workspaceId: string;
  workspacePath: string;
  path: string;
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  deleted: true;
}

/**
 * File-only deletion behind the same path boundary as writes. The caller must
 * prove it is deleting the version it rendered by sending that tree/preview
 * entry's `modifiedAt`; directories and symlink leaves are never accepted.
 */
export async function deleteWorkspaceFile(
  target: WorkspaceTarget,
  input: { path: string; baseModifiedAt: string }
): Promise<WorkspaceFileDeleteResult> {
  const { safePath, leafPath, leafStat } = await resolveMutableWorkspaceEntry(
    target.workspaceRoot,
    input.path,
    "Workspace file is not deletable"
  );
  if (!leafStat.isFile()) {
    throw new WorkspaceExplorerError("Workspace path must be a file", 415);
  }
  if (leafStat.mtime.toISOString() !== input.baseModifiedAt) {
    throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
  }

  await unlink(leafPath);
  return {
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    path: safePath,
    sizeBytes: leafStat.size,
    deleted: true
  };
}

/**
 * Recursive directory deletion is a separate operation from file unlinking.
 * The selected directory must be the version the client rendered, and the
 * complete subtree must pass the protected-name, entry-type, and size caps
 * before `rm` is allowed to touch anything. The workspace root is never a
 * valid entry path, so unregistering a workspace remains metadata-only.
 */
export async function deleteWorkspaceDirectory(
  target: WorkspaceTarget,
  input: { path: string; baseModifiedAt: string }
): Promise<WorkspaceDirectoryDeleteResult> {
  const { safePath, leafPath, leafStat } = await resolveMutableWorkspaceEntry(
    target.workspaceRoot,
    input.path,
    "Workspace directory is not deletable"
  );
  if (!leafStat.isDirectory()) {
    throw new WorkspaceExplorerError("Workspace path must be a directory", 415);
  }
  assertDirectoryUnchanged(leafStat, input.baseModifiedAt);

  const inventory = await inspectBoundedSubtree(leafPath, "delete");
  // Re-check the selected entry after the asynchronous inventory. This keeps
  // the optimistic token meaningful if the directory itself was replaced or
  // changed while the backend walked it. A concurrent nested write remains a
  // documented filesystem race; `rm` never follows a symlink introduced into
  // the tree, but it can remove a new contained file.
  assertDirectoryUnchanged(await restatDirectory(leafPath), input.baseModifiedAt);

  await rm(leafPath, { recursive: true });
  return {
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    path: safePath,
    ...inventory,
    deleted: true
  };
}

async function restatDirectory(leafPath: string): Promise<Stats> {
  try {
    return await lstat(leafPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceExplorerError("Workspace directory changed since it was loaded", 409);
    }
    throw error;
  }
}

function assertDirectoryUnchanged(current: Stats, baseModifiedAt: string): void {
  if (!current.isDirectory() || current.isSymbolicLink() || current.mtime.toISOString() !== baseModifiedAt) {
    throw new WorkspaceExplorerError("Workspace directory changed since it was loaded", 409);
  }
}
