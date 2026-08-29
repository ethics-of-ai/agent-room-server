import { link, lstat, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { WorkspaceFilePreview } from "../../domain/models";
import { hasHiddenPathSegment, maxWriteBytes, tempEntrySuffix } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import { resolveWritableParent } from "./entryMutation";
import { readFilePreview } from "./filePreview";
import { normalizeWorkspaceRelativePath, type WorkspaceTarget } from "./paths";

const deniedMessage = "Workspace file is not writable";

export interface WorkspaceFileWriteResult {
  preview: WorkspaceFilePreview;
  workspacePath: string;
  created: boolean;
}

/**
 * The bounded UTF-8 write seam: the mutating dual of the file preview. It
 * reuses the same path bounding, symlink guard, and secret filtering as the
 * read path; the only deviation is that the leaf may not exist yet, so
 * containment is asserted against the realpath of the PARENT directory rather
 * than the leaf.
 */
export async function writeWorkspaceTextFile(
  target: WorkspaceTarget,
  input: { path: string; content: string; baseModifiedAt?: string }
): Promise<WorkspaceFileWriteResult> {
  const safePath = normalizeWorkspaceRelativePath(input.path);
  if (safePath === "") {
    throw new WorkspaceExplorerError("Workspace file path is required");
  }
  // Refuse every segment hidden from workspace reads, so a write can never
  // create or clobber `.env*`, key material, `.git`, internal staging names, etc.
  if (hasHiddenPathSegment(safePath)) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  const encoded = encodeWritableText(input.content);

  // The parent must already exist (no recursive mkdir in this slice).
  const parentReal = await resolveWritableParent(
    target.workspaceRoot,
    resolve(target.workspaceRoot, safePath),
    deniedMessage
  );
  const leafPath = join(parentReal, basename(safePath));

  const existed = await leafExists(leafPath);
  await assertWriteLockHolds(leafPath, existed, input.baseModifiedAt);
  await publishAtomically(leafPath, encoded, existed);

  // Read back with the write cap (not the smaller browse-preview cap) so a
  // just-written file always echoes in full and the editor stays editable.
  const preview = await readFilePreview(target.workspaceId, leafPath, safePath, maxWriteBytes);
  return { preview, workspacePath: target.workspacePath, created: !existed };
}

// UTF-8 text only, mirroring the preview NUL/binary contract. Encode once: a
// lone surrogate is well-formed JSON but ill-formed UTF-16, and a utf8 write
// would silently coerce it to U+FFFD, so reject any content that does not
// survive a UTF-8 round trip rather than persist mangled bytes. NUL is rejected
// too (it round-trips, so it needs its own check).
function encodeWritableText(content: string): Buffer {
  const encoded = Buffer.from(content, "utf8");
  if (content.includes("\0") || encoded.toString("utf8") !== content) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  return encoded;
}

// Refuse writing through a symlink leaf or clobbering a directory. A missing
// leaf (ENOENT) is an ordinary fresh create.
async function leafExists(leafPath: string): Promise<boolean> {
  try {
    const leafStat = await lstat(leafPath);
    if (leafStat.isSymbolicLink()) {
      throw new WorkspaceExplorerError(deniedMessage, 415);
    }
    if (!leafStat.isFile()) {
      throw new WorkspaceExplorerError("Workspace path must be a file", 415);
    }
    return true;
  } catch (error) {
    if (error instanceof WorkspaceExplorerError) throw error;
    return false;
  }
}

// Optimistic concurrency: reject a blind overwrite of a file that changed since
// the client loaded it. `baseModifiedAt` is the `modifiedAt` the editor rendered.
async function assertWriteLockHolds(leafPath: string, existed: boolean, baseModifiedAt?: string): Promise<void> {
  if (existed) {
    const current = (await stat(leafPath)).mtime.toISOString();
    if (!baseModifiedAt || baseModifiedAt !== current) {
      throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
    }
    return;
  }
  if (baseModifiedAt) {
    // A token means the client is saving a file it previously loaded. If a
    // concurrent rename or delete removed that path, do not reinterpret the
    // save as a fresh create and resurrect the stale name.
    throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
  }
}

// Atomic publish. Use a per-write unique temp name (not just the pid) so two
// concurrent writes to the same leaf can never collide on the temp file.
// `flag: "wx"` (O_EXCL) refuses to follow or clobber anything planted at the
// temp name, closing the TOCTOU window.
async function publishAtomically(leafPath: string, encoded: Buffer, existed: boolean): Promise<void> {
  const tmpPath = `${leafPath}.${randomUUID()}${tempEntrySuffix}`;
  await writeFile(tmpPath, encoded, { flag: "wx" });
  try {
    if (existed) {
      // Optimistic lock already checked; atomically replace the leaf name itself
      // (never writes through a symlink at the destination).
      await rename(tmpPath, leafPath);
    } else {
      // Atomic create-only: `link` fails with EEXIST if another writer created the
      // leaf since the existence check, so a concurrent create is reported as a
      // conflict instead of being silently clobbered or mislabeled as our create.
      await link(tmpPath, leafPath);
    }
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (!existed && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceExplorerError("Workspace file changed since it was loaded", 409);
    }
    throw error;
  }
  if (!existed) {
    // `link` leaves the temp behind (only `rename` consumes it); drop it now.
    await rm(tmpPath, { force: true });
  }
}
