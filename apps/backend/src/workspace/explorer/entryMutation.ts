import { link, lstat, mkdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isInside } from "../../util/pathBounding";
import { hasHiddenPathSegment, maxCollisionOrdinal } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import { joinWorkspacePath, normalizeWorkspaceRelativePath } from "./paths";

/**
 * The shared bounding every entry mutation (delete, rename, move, copy) applies
 * before it touches anything: the lexical bound on the caller's text, realpath
 * containment asserted against the *parent* (the leaf may be replaced under
 * us), the secret/generated refusal on both the caller's text and the resolved
 * parent, all names hidden from the workspace read surfaces, and a refusal to
 * operate through a symlink leaf.
 */
export async function resolveMutableWorkspaceEntry(
  workspaceRoot: string,
  inputPath: string,
  deniedMessage: string
): Promise<{ safePath: string; parentReal: string; leafPath: string; leafStat: Stats }> {
  const safePath = normalizeWorkspaceRelativePath(inputPath);
  if (safePath === "") {
    throw new WorkspaceExplorerError("Workspace entry path is required");
  }
  if (hasHiddenPathSegment(safePath)) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }

  const parentReal = await resolveWritableParent(workspaceRoot, resolve(workspaceRoot, safePath), deniedMessage);
  const leafPath = join(parentReal, basename(safePath));
  let leafStat: Stats;
  try {
    leafStat = await lstat(leafPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceExplorerError("Workspace path was not found", 404);
    }
    throw error;
  }
  if (leafStat.isSymbolicLink()) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  return { safePath, parentReal, leafPath, leafStat };
}

/**
 * The parent half of every write. `realpath` throws on a not-yet-existing leaf,
 * so containment is asserted here instead — and the resolved path is filtered
 * as well as the caller's text, because a lexical path such as
 * `visible/config` can still reach `.git/config` when `visible` is a symlink
 * whose target remains inside the workspace.
 */
export async function resolveWritableParent(
  workspaceRoot: string,
  targetPath: string,
  deniedMessage: string
): Promise<string> {
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(targetPath));
  } catch {
    throw new WorkspaceExplorerError("Workspace path was not found", 404);
  }
  if (!isInside(workspaceRoot, parentReal)) {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  }
  if (hasHiddenPathSegment(relative(workspaceRoot, parentReal))) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  return parentReal;
}

// The destination half of a move or copy. Relocating reaches a *second*
// directory, so it gets exactly the treatment the source's own parent gets on
// every other write: the lexical bound, realpath containment, and the
// hidden-segment refusal applied to the resolved path as well as to the
// caller's text. "" is the workspace root, the one destination that is
// always present.
export async function resolveDestinationParent(
  workspaceRoot: string,
  inputParent: string,
  deniedMessage: string
): Promise<{ safeParent: string; parentReal: string }> {
  const safeParent = normalizeWorkspaceRelativePath(inputParent);
  if (hasHiddenPathSegment(safeParent)) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }

  let parentReal: string;
  try {
    parentReal = await realpath(resolve(workspaceRoot, safeParent));
  } catch {
    throw new WorkspaceExplorerError("Workspace path was not found", 404);
  }
  if (!isInside(workspaceRoot, parentReal)) {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  }
  // A lexical destination such as `visible/sub` can still resolve into `.git`
  // when `visible` is a symlink whose target stays inside the workspace, so the
  // resolved path is filtered too — the same asymmetry the file write handles.
  if (hasHiddenPathSegment(relative(workspaceRoot, parentReal))) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }
  if (!(await stat(parentReal)).isDirectory()) {
    throw new WorkspaceExplorerError("Workspace destination must be a directory", 415);
  }
  return { safeParent, parentReal };
}

// A folder cannot become its own descendant: moving one inside itself detaches
// it from the tree, and copying one inside itself recurses forever. The
// comparison is on realpaths (and `isInside` is true for the folder itself), so
// a symlinked destination cannot smuggle the source's own subtree past a purely
// lexical check.
export function assertNotInsideSource(
  entryType: "file" | "directory",
  leafPath: string,
  destinationParentReal: string,
  verb: "move" | "copy"
): void {
  if (entryType !== "directory") return;
  if (isInside(leafPath, destinationParentReal)) {
    throw new WorkspaceExplorerError(`Workspace folder cannot ${verb} inside itself`);
  }
}

// Pick the name a copy actually lands under. `fail` (the default) refuses an
// occupied destination exactly as rename does. `keep_both` walks the same
// deterministic `-2`…`-5` ladder `DiagramWritePlan` walks client-side and then
// refuses. The server never renames unless it was asked to, and it reports the
// name it chose rather than leaving the client to guess.
export async function resolveCopyDestinationName(
  parentReal: string,
  safeParent: string,
  requestedName: string,
  onCollision: "fail" | "keep_both",
  deniedMessage: string
): Promise<string> {
  for (let ordinal = 1; ordinal <= maxCollisionOrdinal; ordinal += 1) {
    const candidate = ordinal === 1 ? requestedName : collisionCandidateName(requestedName, ordinal);
    if (candidate === undefined) break;
    if (hasHiddenPathSegment(joinWorkspacePath(safeParent, candidate))) {
      throw new WorkspaceExplorerError(deniedMessage, 415);
    }
    try {
      await lstat(join(parentReal, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
    if (onCollision === "fail") break;
  }
  throw new WorkspaceExplorerError("Workspace path already exists", 409);
}

// `notes.md` collides into `notes-2.md`, not `notes.md-2`. A leading dot is part
// of the name rather than an extension, so `.gitignore` becomes `.gitignore-2`.
// The result must still fit the leaf-name byte cap; appending past it gives up
// rather than truncating, because a silently shortened filename is worse than
// being told the name is taken.
function collisionCandidateName(name: string, ordinal: number): string | undefined {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const candidate = `${stem}-${ordinal}${extension}`;
  return Buffer.byteLength(candidate, "utf8") <= 255 ? candidate : undefined;
}

export async function renameFileWithoutOverwrite(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    // `link` is exclusive at the destination and same-parent paths are always
    // on one filesystem. Once linked, both names identify the same inode until
    // the old leaf is removed; no sibling can be overwritten in between.
    await link(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    // Only a move can reach this: a rename stays in one directory and a copy
    // stages beside its destination, so both are always on one filesystem. A
    // volume mounted inside a registered workspace is what makes it possible.
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new WorkspaceExplorerError("Workspace entry cannot cross a filesystem boundary", 415);
    }
    throw error;
  }
  try {
    await unlink(sourcePath);
  } catch (error) {
    // Best-effort rollback restores the original one-name state. If another
    // local process interfered with the new hard link, preserve the original
    // error rather than recursively touching anything at the destination.
    try {
      await unlink(destinationPath);
    } catch {
      // The source still exists, so failure to remove the second link does not
      // lose the file; surface the original unlink error to the caller.
    }
    throw error;
  }
}

export async function renameDirectoryWithoutOverwrite(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    // Reserving the destination with an empty owner-only directory closes the
    // absent-name race. POSIX rename may replace that empty reservation, but it
    // can never replace a sibling another caller already owned.
    await mkdir(destinationPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    throw error;
  }
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    try {
      await rmdir(destinationPath);
    } catch {
      // Never recurse during rollback. A local actor that populated the
      // reservation wins a visible leftover over having its data removed.
    }
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    // See the file helper: reachable only from a cross-device move.
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new WorkspaceExplorerError("Workspace entry cannot cross a filesystem boundary", 415);
    }
    throw error;
  }
}
