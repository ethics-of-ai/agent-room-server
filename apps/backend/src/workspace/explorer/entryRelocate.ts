import { lstat, realpath, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { hasHiddenPathSegment } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import {
  assertNotInsideSource,
  renameDirectoryWithoutOverwrite,
  renameFileWithoutOverwrite,
  resolveDestinationParent,
  resolveMutableWorkspaceEntry
} from "./entryMutation";
import { joinWorkspacePath, normalizeWorkspaceLeafName, normalizeWorkspaceRelativePath, type WorkspaceTarget } from "./paths";

export interface WorkspaceEntryRelocateResult {
  workspaceId: string;
  workspacePath: string;
  oldPath: string;
  path: string;
  entryType: "file" | "directory";
  sizeBytes?: number;
  moved: boolean;
}

export interface WorkspaceEntryRenameResult extends Omit<WorkspaceEntryRelocateResult, "moved"> {
  renamed: boolean;
}

/**
 * Rename changes one leaf name in place: the destination parent is the entry's
 * own, so no second directory is reached and the caller cannot express one.
 * The narrow contract is the point, and it is preserved by *delegating* rather
 * than by keeping a second implementation of the same filesystem dance.
 */
export async function renameWorkspaceEntry(
  target: WorkspaceTarget,
  input: { path: string; newName: string; baseModifiedAt: string }
): Promise<WorkspaceEntryRenameResult> {
  // Normalizing here only to read the parent back off the path keeps the
  // delegation honest: an out-of-bounds path still fails inside `relocate`
  // with the same error it always did.
  const safePath = normalizeWorkspaceRelativePath(input.path);
  const slash = safePath.lastIndexOf("/");
  const { moved, ...result } = await relocateWorkspaceEntry(
    target,
    {
      path: input.path,
      destinationParent: slash >= 0 ? safePath.slice(0, slash) : "",
      newName: input.newName,
      baseModifiedAt: input.baseModifiedAt
    },
    "Workspace entry is not renamable"
  );
  return { ...result, renamed: moved };
}

/**
 * Move relocates one entry to another directory in the same workspace, keeping
 * its name or taking a new leaf. It is rename's generalization and shares its
 * whole no-overwrite contract; what it adds is a *second* directory to bound,
 * so the destination parent gets the same lexical bound, realpath containment,
 * and secret/generated refusal the source does, plus the two refusals only a
 * cross-directory operation can hit: a folder moving inside itself, and a
 * destination on another filesystem.
 */
export async function moveWorkspaceEntry(
  target: WorkspaceTarget,
  input: { path: string; destinationParent: string; newName?: string; baseModifiedAt: string }
): Promise<WorkspaceEntryRelocateResult> {
  return relocateWorkspaceEntry(target, input, "Workspace entry is not movable");
}

/**
 * The one implementation behind both rename and move. Files claim the
 * destination with an exclusive hard link before unlinking the old leaf;
 * directories reserve an empty destination directory before rename. Both avoid
 * POSIX rename's otherwise destructive check-then-overwrite race.
 */
async function relocateWorkspaceEntry(
  target: WorkspaceTarget,
  input: { path: string; destinationParent: string; newName?: string; baseModifiedAt: string },
  deniedMessage: string
): Promise<WorkspaceEntryRelocateResult> {
  const { safePath, leafPath, leafStat } = await resolveMutableWorkspaceEntry(
    target.workspaceRoot,
    input.path,
    deniedMessage
  );
  const entryType = requireRelocatableEntryType(leafStat.isFile(), leafStat.isDirectory());
  if (leafStat.mtime.toISOString() !== input.baseModifiedAt) {
    throw new WorkspaceExplorerError("Workspace entry changed since it was loaded", 409);
  }

  // An omitted name means "keep it", which is what a paste into another folder
  // does; `basename` of an already-bounded path is a leaf by construction.
  const newName = normalizeWorkspaceLeafName(input.newName ?? basename(safePath));
  const { safeParent, parentReal } = await resolveDestinationParent(
    target.workspaceRoot,
    input.destinationParent,
    deniedMessage
  );
  const newPath = joinWorkspacePath(safeParent, newName);
  if (hasHiddenPathSegment(newPath)) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  assertNotInsideSource(entryType, leafPath, parentReal, "move");

  const describe = (path: string, moved: boolean): WorkspaceEntryRelocateResult => ({
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    oldPath: safePath,
    path,
    entryType,
    ...(entryType === "file" ? { sizeBytes: leafStat.size } : {}),
    moved
  });

  if (newPath === safePath) return describe(newPath, false);

  const destinationPath = join(parentReal, newName);
  // A symlinked destination parent can resolve straight back to the source
  // parent. Keeping the same leaf then changes no directory entry, regardless
  // of the caller's alternate spelling, so do not emit a vacating move event.
  if (destinationPath === leafPath) return describe(safePath, false);

  if (await destinationIsSameEntry(leafPath, destinationPath, leafStat.dev, leafStat.ino)) {
    // Case-only renames on the default macOS filesystem resolve both spellings
    // to the same inode. That is the one existing destination this operation
    // may replace; every other sibling is a conflict.
    await rename(leafPath, destinationPath);
  } else if (entryType === "file") {
    await renameFileWithoutOverwrite(leafPath, destinationPath);
  } else {
    await renameDirectoryWithoutOverwrite(leafPath, destinationPath);
  }
  return describe(newPath, true);
}

/** Relocation and copy both accept exactly a regular file or a directory. */
export function requireRelocatableEntryType(isFile: boolean, isDirectory: boolean): "file" | "directory" {
  if (isFile) return "file";
  if (isDirectory) return "directory";
  throw new WorkspaceExplorerError("Workspace path must be a file or directory", 415);
}

async function destinationIsSameEntry(
  sourcePath: string,
  destinationPath: string,
  dev: number,
  ino: number
): Promise<boolean> {
  try {
    const destinationStat = await lstat(destinationPath);
    if (destinationStat.dev !== dev || destinationStat.ino !== ino) {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    // A matching inode is not enough: two ordinary hard links also share it,
    // and POSIX rename between them is a no-op that leaves both names present.
    // Only two spellings that realpath resolves to the same directory entry are
    // the case-only rename exception used on a case-insensitive filesystem.
    const [sourceReal, destinationReal] = await Promise.all([realpath(sourcePath), realpath(destinationPath)]);
    if (sourceReal !== destinationReal) {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    return true;
  } catch (error) {
    if (error instanceof WorkspaceExplorerError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}
