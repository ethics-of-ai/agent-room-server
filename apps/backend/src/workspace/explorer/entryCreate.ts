import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hasHiddenPathSegment } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import { resolveWritableParent } from "./entryMutation";
import {
  joinWorkspacePath,
  normalizeWorkspaceLeafName,
  normalizeWorkspaceRelativePath,
  type WorkspaceTarget
} from "./paths";

const deniedMessage = "Workspace directory is not creatable";

export interface WorkspaceDirectoryCreateResult {
  workspaceId: string;
  workspacePath: string;
  path: string;
  modifiedAt: string;
  created: true;
}

/**
 * The one workspace write that adds a container rather than content, and the
 * only mutation with no optimistic-lock token: there is no prior version to
 * clobber, so a token would be protecting nothing. That makes it create-only in
 * the same sense a `PUT` with no `baseModifiedAt` is, and an occupied name is
 * the `409` every other no-overwrite operation gives.
 *
 * It is deliberately **not** recursive. The parent must already exist, exactly
 * as it must for the bounded file write, so one request creates one directory
 * and a caller that wants a chain asks for each link. `mkdir` without
 * `recursive` is also exclusive, which is what turns an occupied name into
 * `EEXIST` instead of a silent success on someone else's folder.
 */
export async function createWorkspaceDirectory(
  target: WorkspaceTarget,
  input: { path: string }
): Promise<WorkspaceDirectoryCreateResult> {
  const safePath = normalizeWorkspaceRelativePath(input.path);
  if (safePath === "") {
    // "" is the workspace root, which already exists and is never an entry target.
    throw new WorkspaceExplorerError("Workspace directory path is required");
  }
  if (hasHiddenPathSegment(safePath)) {
    throw new WorkspaceExplorerError(deniedMessage, 415);
  }

  // The leaf goes through rename's own name rule, so the 255-byte cap and the
  // `.`/`..` refusal are stated once rather than restated here — and an
  // over-long name is a bounded refusal rather than a raw `ENAMETOOLONG` fault.
  // The reported path is rebuilt from that checked leaf, so what the response
  // names and what was created cannot disagree.
  const segments = safePath.split("/");
  const leafName = normalizeWorkspaceLeafName(segments[segments.length - 1]);
  const safeParent = segments.slice(0, -1).join("/");

  const parentReal = await resolveWritableParent(
    target.workspaceRoot,
    resolve(target.workspaceRoot, safePath),
    deniedMessage
  );
  const leafPath = join(parentReal, leafName);

  try {
    await mkdir(leafPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new WorkspaceExplorerError("Workspace path already exists", 409);
    }
    // `resolveWritableParent` already proved the parent resolves, so this is
    // only reachable when it was removed between that check and this call.
    if (code === "ENOENT") {
      throw new WorkspaceExplorerError("Workspace path was not found", 404);
    }
    throw error;
  }

  return {
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    path: joinWorkspacePath(safeParent, leafName),
    // The tree read reports a directory's `modifiedAt` and the entry mutations
    // require it, so returning it here makes the new folder an immediate
    // rename, move, paste, or delete target without a second read.
    modifiedAt: (await stat(leafPath)).mtime.toISOString(),
    created: true
  };
}
