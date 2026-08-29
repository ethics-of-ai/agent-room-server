import type { WorkspaceGitFileBaseline } from "../../domain/models";
import type { LocalWorkspaceRegistry } from "../LocalWorkspaceRegistry";
import { hasSecretPathSegment, maxWriteBytes } from "./bounds";
import { WorkspaceExplorerError } from "./errors";
import { normalizeWorkspaceRelativePath, type WorkspaceTarget } from "./paths";

/** The registry surface the baseline read needs: one fixed `git cat-file`. */
type GitBaselineRegistry = Pick<LocalWorkspaceRegistry, "gitFileAtHead">;

/**
 * Bounded read of the git HEAD version of a workspace file, so an editor can
 * diff the working tree against the committed baseline. Shares the preview
 * path's lexical bound, secret filtering, byte cap, and NUL/binary contract.
 * Realpath containment cannot apply here because the HEAD blob need not exist
 * on disk (a deleted or renamed working file still has a baseline); the bound
 * is the lexically-normalized, `./`-anchored pathspec resolved by git inside
 * the registered workspace directory.
 */
export async function readGitFileBaseline(
  registry: GitBaselineRegistry,
  target: WorkspaceTarget,
  input: { path: string; maxBytes?: number }
): Promise<WorkspaceGitFileBaseline> {
  const safePath = normalizeWorkspaceRelativePath(input.path);
  if (safePath === "") {
    throw new WorkspaceExplorerError("Workspace file path is required");
  }
  // Refuse secret-named segments anywhere in the path: a committed `.env` or key
  // file is exactly as sensitive at HEAD as it is in the working tree.
  if (hasSecretPathSegment(safePath)) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }

  const result = await registry.gitFileAtHead(target.workspaceId, safePath, input.maxBytes ?? maxWriteBytes);
  const base = { workspaceId: target.workspaceId, path: safePath, ref: "HEAD" as const };
  if (!result.isRepository) return { ...base, isRepository: false, existsInHead: false };
  if (!result.existsInHead) return { ...base, isRepository: true, existsInHead: false };
  if (result.objectKind !== "blob") {
    throw new WorkspaceExplorerError("Workspace path must be a file", 415);
  }
  if (result.binary) {
    throw new WorkspaceExplorerError("Workspace file is not previewable", 415);
  }
  if (result.truncated || result.content === undefined) {
    return { ...base, isRepository: true, existsInHead: true, sizeBytes: result.sizeBytes, truncated: true };
  }
  return {
    ...base,
    isRepository: true,
    existsInHead: true,
    sizeBytes: result.sizeBytes,
    encoding: "utf8",
    content: result.content,
    truncated: false
  };
}
