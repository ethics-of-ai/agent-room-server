import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTreeEntry } from "../../domain/models";
import { isHiddenEntryName, isPreviewableName, maxEntriesPerDirectory, maxWriteBytes } from "./bounds";
import { compareDirents, joinWorkspacePath, safeRealpath } from "./paths";

/**
 * The bounded tree read. Entries are capped per directory, generated and
 * secret-named entries never appear, and the only entry that can point outside
 * the workspace — a symlink — is realpath-checked and dropped rather than
 * followed. Recursion is depth-bounded by the caller.
 */
export async function readDirectoryEntries(
  workspaceRoot: string,
  directoryPath: string,
  directoryRelativePath: string,
  depthRemaining: number
): Promise<WorkspaceTreeEntry[]> {
  const dirents = await readdir(directoryPath, { withFileTypes: true });
  const candidates = dirents
    .sort(compareDirents)
    .slice(0, maxEntriesPerDirectory)
    .filter((dirent) => !isHiddenEntryName(dirent.name));
  const entries = await Promise.all(candidates.map(async (dirent): Promise<WorkspaceTreeEntry | undefined> => {
    const childRelativePath = joinWorkspacePath(directoryRelativePath, dirent.name);
    const childPath = join(directoryPath, dirent.name);
    // Only a symlink can point outside the workspace: a regular entry
    // physically lives under its parent, which is already a contained
    // realpath, so it needs one lstat instead of a realpath chain + stat.
    let childResolvedPath = childPath;
    let childStat;
    if (dirent.isSymbolicLink()) {
      const childRealPath = await safeRealpath(workspaceRoot, childPath);
      if (!childRealPath) return undefined;
      childResolvedPath = childRealPath;
      childStat = await stat(childRealPath);
    } else {
      childStat = await lstat(childPath);
    }
    if (childStat.isDirectory()) {
      return {
        type: "directory",
        name: dirent.name,
        path: childRelativePath,
        modifiedAt: childStat.mtime.toISOString(),
        ...(depthRemaining > 0
          ? { children: await readDirectoryEntries(workspaceRoot, childResolvedPath, childRelativePath, depthRemaining - 1) }
          : {})
      };
    }
    if (childStat.isFile()) {
      return {
        type: "file",
        name: dirent.name,
        path: childRelativePath,
        sizeBytes: childStat.size,
        modifiedAt: childStat.mtime.toISOString(),
        // Previewable means "a text file the editor can open and save": a non-binary,
        // non-secret name within the write cap. The editor loads it with `maxBytes` up to
        // `maxWriteBytes` (see `filePreviewQuerySchema`), so the open/edit gate is the
        // write cap, not the smaller 24 KB browse-content default.
        previewable: isPreviewableName(dirent.name) && childStat.size <= maxWriteBytes
      };
    }
    return undefined;
  }));
  return entries.filter((entry): entry is WorkspaceTreeEntry => entry !== undefined);
}
