import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { boundedRelativeSegments, isInside } from "../../util/pathBounding";
import { isHiddenEntryName, maxDepth } from "./bounds";
import { WorkspaceExplorerError } from "./errors";

// Every workspace-relative path a client supplies passes through here before a
// filesystem call: the lexical bound first (NUL, absolute, and `..` rejected),
// then realpath containment where a path names something that must already
// exist. Nothing below assumes the caller's text and the resolved path agree —
// a contained symlink can make them differ, which is why both are filtered.

export function normalizeWorkspaceRelativePath(inputPath: string): string {
  // Shares the lexical bound with the editor catalog asset route; the empty result (workspace
  // root) is intentionally allowed here, unlike the catalog where an empty asset path is rejected.
  return boundedRelativeSegments(inputPath, () => {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  });
}

export function normalizeWorkspaceLeafName(inputName: string): string {
  const name = inputName.trim();
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new WorkspaceExplorerError("New name must be one file or folder name");
  }
  if (Buffer.byteLength(name, "utf8") > 255) {
    throw new WorkspaceExplorerError("New name must be at most 255 bytes");
  }
  return name;
}

export async function resolveInsideWorkspace(workspaceRoot: string, safePath: string): Promise<string> {
  const targetPath = resolve(workspaceRoot, safePath);
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(targetPath);
  } catch {
    throw new WorkspaceExplorerError("Workspace path was not found", 404);
  }
  if (!isInside(workspaceRoot, targetRealPath)) {
    throw new WorkspaceExplorerError("Workspace path must stay inside the registered workspace");
  }
  return targetRealPath;
}

/** Realpath containment as a filter rather than a refusal: an escaping link is skipped. */
export async function safeRealpath(workspaceRoot: string, targetPath: string): Promise<string | undefined> {
  try {
    const targetRealPath = await realpath(targetPath);
    return isInside(workspaceRoot, targetRealPath) ? targetRealPath : undefined;
  } catch {
    return undefined;
  }
}

export function joinWorkspacePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

// The index's path filter. Applies the same lexical bound as every other
// workspace read (rejecting NUL, absolute paths, and `..`) and then the tree
// read's per-segment refusals, so a `.env`, key file, `.git` object, or
// generated-directory entry can never enter the index — and therefore can never
// be listed by the file index, scanned by the content search, or named as a
// pathspec by a git operation (`WorkspaceGitService` shares this filter, which is
// what keeps a secret-named file out of the index AgentRoom would then commit).
export function indexableRelativePath(rawPath: string): string | undefined {
  let safePath: string;
  try {
    safePath = normalizeWorkspaceRelativePath(rawPath);
  } catch {
    return undefined;
  }
  if (!safePath) return undefined;
  if (safePath.split("/").some((segment) => isHiddenEntryName(segment))) {
    return undefined;
  }
  return safePath;
}

/** Directories first, then names, so a tree and a walk enumerate in one order. */
export function compareDirents(
  left: { isDirectory(): boolean; name: string },
  right: { isDirectory(): boolean; name: string }
): number {
  if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 2;
  return Math.min(Math.max(Math.floor(depth), 0), maxDepth);
}

/**
 * The resolved workspace every bounded operation runs against: the registry's
 * own id and path for reporting, plus the realpath containment is asserted
 * from. Resolving it once per request keeps that pair from being re-derived —
 * and re-derived differently — in each operation.
 */
export interface WorkspaceTarget {
  workspaceId: string;
  /** The registered path, as recorded — what events and results report. */
  workspacePath: string;
  /** The realpath every containment check is made against. */
  workspaceRoot: string;
}
