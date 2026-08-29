import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { maxSubtreeBytes, tempEntrySuffix } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import {
  assertNotInsideSource,
  renameDirectoryWithoutOverwrite,
  renameFileWithoutOverwrite,
  resolveCopyDestinationName,
  resolveDestinationParent,
  resolveMutableWorkspaceEntry
} from "./entryMutation";
import { requireRelocatableEntryType } from "./entryRelocate";
import { joinWorkspacePath, normalizeWorkspaceLeafName, type WorkspaceTarget } from "./paths";
import { copyBoundedFile, copyBoundedSubtree, inspectBoundedSubtree, type SubtreeInventory } from "./subtree";

const deniedMessage = "Workspace entry is not copyable";

export interface WorkspaceEntryCopyResult extends SubtreeInventory {
  workspaceId: string;
  workspacePath: string;
  sourcePath: string;
  path: string;
  entryType: "file" | "directory";
  copied: true;
}

/**
 * Copy duplicates one entry inside the same workspace. It is the one write on
 * this surface whose bytes never transit the API, so `maxWriteBytes` (a
 * request-body bound) says nothing about it and the subtree caps bound it
 * instead — for a single file as much as for a tree. Everything is inventoried
 * before a byte is written, and the result is published under the caller's
 * chosen name only once it is complete, so a failure leaves nothing partial
 * for someone to mistake for the copy they asked for.
 */
export async function copyWorkspaceEntry(
  target: WorkspaceTarget,
  input: {
    path: string;
    destinationParent: string;
    newName?: string;
    baseModifiedAt: string;
    onCollision?: "fail" | "keep_both";
  }
): Promise<WorkspaceEntryCopyResult> {
  const { safePath, leafPath, leafStat } = await resolveMutableWorkspaceEntry(
    target.workspaceRoot,
    input.path,
    deniedMessage
  );
  const entryType = requireRelocatableEntryType(leafStat.isFile(), leafStat.isDirectory());
  // Copy does not touch the source, so the token is not protecting it from
  // loss; it is what makes "this is a copy of the entry I was looking at"
  // true. A stale token means the client should re-read and copy again.
  if (leafStat.mtime.toISOString() !== input.baseModifiedAt) {
    throw new WorkspaceExplorerError("Workspace entry changed since it was loaded", 409);
  }

  const requestedName = normalizeWorkspaceLeafName(input.newName ?? basename(safePath));
  const { safeParent, parentReal } = await resolveDestinationParent(
    target.workspaceRoot,
    input.destinationParent,
    deniedMessage
  );
  assertNotInsideSource(entryType, leafPath, parentReal, "copy");

  // Inventory before writing. A single file is its own one-entry subtree, so
  // both shapes are bounded by the same two numbers.
  if (entryType === "directory") {
    await inspectBoundedSubtree(leafPath, "copy");
  } else {
    boundedFileSize(leafStat.size);
  }

  const newName = await resolveCopyDestinationName(
    parentReal,
    safeParent,
    requestedName,
    input.onCollision ?? "fail",
    deniedMessage
  );
  const destinationPath = join(parentReal, newName);

  // Stage beside the destination, then publish under the chosen name with the
  // same exclusive-claim helpers rename uses. A copy is never visible under a
  // half-written name, and it can never replace a sibling.
  const stagingPath = `${destinationPath}.${randomUUID()}${tempEntrySuffix}`;
  let inventory: SubtreeInventory;
  try {
    if (entryType === "file") {
      inventory = {
        fileCount: 1,
        directoryCount: 0,
        sizeBytes: await copyBoundedFile(leafPath, stagingPath, leafStat)
      };
      await renameFileWithoutOverwrite(stagingPath, destinationPath);
    } else {
      inventory = await copyBoundedSubtree(leafPath, stagingPath, leafStat);
      await renameDirectoryWithoutOverwrite(stagingPath, destinationPath);
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }

  return {
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    sourcePath: safePath,
    path: joinWorkspacePath(safeParent, newName),
    entryType,
    ...inventory,
    copied: true
  };
}

function boundedFileSize(sizeBytes: number): number {
  if (sizeBytes > maxSubtreeBytes) {
    throw new WorkspaceExplorerError("Workspace file is too large to copy", 413);
  }
  return sizeBytes;
}
