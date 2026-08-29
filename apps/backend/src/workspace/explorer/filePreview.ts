import { lstat, open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { WorkspaceFilePreview } from "../../domain/models";
import { isPreviewableName } from "./bounds";
import { WorkspaceExplorerError } from "./errors";

/**
 * The bounded UTF-8 preview every read of workspace file content goes through —
 * the file preview route, the spatial scene composer, the diagram trackers, and
 * the editor's full-file load. A secret-named or binary file is refused rather
 * than partially returned, and an over-cap file reports `truncated` instead of
 * failing, since a browse read is allowed to show a head.
 */
export async function readFilePreview(
  workspaceId: string,
  targetPath: string,
  safePath: string,
  maxBytes: number
): Promise<WorkspaceFilePreview> {
  const entryStat = await lstat(targetPath);
  if (!entryStat.isFile() && !entryStat.isSymbolicLink()) {
    throw new WorkspaceExplorerError("Workspace path must be a file");
  }
  const fileStat = await stat(targetPath);
  if (!fileStat.isFile()) {
    throw new WorkspaceExplorerError("Workspace path must be a file");
  }
  if (!isPreviewableName(basename(safePath))) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }

  const previewBuffer = await readFileHead(targetPath, Math.min(fileStat.size, maxBytes));
  if (previewBuffer.includes(0)) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }
  return {
    workspaceId,
    path: safePath,
    name: basename(safePath),
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    encoding: "utf8",
    content: previewBuffer.toString("utf8"),
    truncated: fileStat.size > maxBytes,
    previewable: true
  };
}

/**
 * Reads at most `bytesToRead` from the head of a file and closes the handle,
 * which is all three bounded readers here need: the preview, the search scan,
 * and the skills frontmatter head. Nothing streams a whole file.
 */
export async function readFileHead(targetPath: string, bytesToRead: number): Promise<Buffer> {
  const file = await open(targetPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
}
