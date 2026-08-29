import { realpath, stat } from "node:fs/promises";
import type {
  AgentRunnerKind,
  WorkspaceFileIndexSnapshot,
  WorkspaceFilePreview,
  WorkspaceGitFileBaseline,
  WorkspaceSearchSnapshot,
  WorkspaceSkill,
  WorkspaceTreeSnapshot
} from "../domain/models";
import { runnerDescriptor } from "../runner/registry";
import type { LocalWorkspaceRegistry } from "./LocalWorkspaceRegistry";
import { clampDepth, normalizeWorkspaceRelativePath, resolveInsideWorkspace, type WorkspaceTarget } from "./explorer/paths";
import { maxPreviewBytes } from "./explorer/bounds";
import { WorkspaceExplorerError } from "./explorer/errors";
import { readDirectoryEntries } from "./explorer/directoryRead";
import { readFilePreview } from "./explorer/filePreview";
import { readGitFileBaseline } from "./explorer/gitBaseline";
import { WorkspaceFileIndexCache } from "./explorer/fileIndex";
import { listIndexedFiles } from "./explorer/fileListing";
import { searchIndexedFiles } from "./explorer/contentSearch";
import { listWorkspaceSkills } from "./explorer/skills";
import { writeWorkspaceTextFile, type WorkspaceFileWriteResult } from "./explorer/fileWrite";
import { createWorkspaceDirectory, type WorkspaceDirectoryCreateResult } from "./explorer/entryCreate";
import {
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  type WorkspaceDirectoryDeleteResult,
  type WorkspaceFileDeleteResult
} from "./explorer/entryDelete";
import {
  moveWorkspaceEntry,
  renameWorkspaceEntry,
  type WorkspaceEntryRelocateResult,
  type WorkspaceEntryRenameResult
} from "./explorer/entryRelocate";
import { copyWorkspaceEntry, type WorkspaceEntryCopyResult } from "./explorer/entryCopy";
import { buildPromptWithContext } from "./explorer/promptContext";

// The bounded workspace surface, assembled from `./explorer`. Each operation
// there owns one contract — the tree read, the preview, the index and search,
// the skills scan, and the seven fixed mutations — while this class owns the one
// thing they share: resolving a registered workspace id to the realpath every
// bound is asserted against, and holding the per-workspace file index between
// requests. Every rule those operations apply is documented in
// `docs/safety/TRUST_AND_SAFETY.md`; none of them is relaxed here.

export { WorkspaceExplorerError } from "./explorer/errors";
export { indexableRelativePath } from "./explorer/paths";
export { maxSubtreeBytes, maxSubtreeEntries, maxWriteBytes } from "./explorer/bounds";
export { maxFileIndexResults } from "./explorer/fileListing";
export { maxSearchMatches } from "./explorer/contentSearch";

export class WorkspaceExplorer {
  private readonly fileIndex: WorkspaceFileIndexCache;

  constructor(private readonly registry: LocalWorkspaceRegistry) {
    this.fileIndex = new WorkspaceFileIndexCache(registry);
  }

  async tree(workspaceId: string, input: { path?: string; depth?: number } = {}): Promise<WorkspaceTreeSnapshot> {
    const target = await this.target(workspaceId);
    const safePath = normalizeWorkspaceRelativePath(input.path ?? "");
    const targetPath = await resolveInsideWorkspace(target.workspaceRoot, safePath);
    if (!(await stat(targetPath)).isDirectory()) {
      throw new WorkspaceExplorerError("Workspace path must be a directory");
    }

    return {
      workspaceId,
      path: safePath,
      entries: await readDirectoryEntries(target.workspaceRoot, targetPath, safePath, clampDepth(input.depth ?? 2))
    };
  }

  async filePreview(workspaceId: string, input: { path: string; maxBytes?: number }): Promise<WorkspaceFilePreview> {
    const target = await this.target(workspaceId);
    const safePath = normalizeWorkspaceRelativePath(input.path);
    const targetPath = await resolveInsideWorkspace(target.workspaceRoot, safePath);
    return readFilePreview(workspaceId, targetPath, safePath, input.maxBytes ?? maxPreviewBytes);
  }

  async gitFileBaseline(
    workspaceId: string,
    input: { path: string; maxBytes?: number }
  ): Promise<WorkspaceGitFileBaseline> {
    return readGitFileBaseline(this.registry, await this.target(workspaceId), input);
  }

  async writeTextFile(
    workspaceId: string,
    input: { path: string; content: string; baseModifiedAt?: string }
  ): Promise<WorkspaceFileWriteResult> {
    return writeWorkspaceTextFile(await this.target(workspaceId), input);
  }

  async createDirectory(workspaceId: string, input: { path: string }): Promise<WorkspaceDirectoryCreateResult> {
    return createWorkspaceDirectory(await this.target(workspaceId), input);
  }

  async deleteFile(
    workspaceId: string,
    input: { path: string; baseModifiedAt: string }
  ): Promise<WorkspaceFileDeleteResult> {
    return deleteWorkspaceFile(await this.target(workspaceId), input);
  }

  async deleteDirectory(
    workspaceId: string,
    input: { path: string; baseModifiedAt: string }
  ): Promise<WorkspaceDirectoryDeleteResult> {
    return deleteWorkspaceDirectory(await this.target(workspaceId), input);
  }

  async renameEntry(
    workspaceId: string,
    input: { path: string; newName: string; baseModifiedAt: string }
  ): Promise<WorkspaceEntryRenameResult> {
    return renameWorkspaceEntry(await this.target(workspaceId), input);
  }

  async moveEntry(
    workspaceId: string,
    input: { path: string; destinationParent: string; newName?: string; baseModifiedAt: string }
  ): Promise<WorkspaceEntryRelocateResult> {
    return moveWorkspaceEntry(await this.target(workspaceId), input);
  }

  async copyEntry(
    workspaceId: string,
    input: {
      path: string;
      destinationParent: string;
      newName?: string;
      baseModifiedAt: string;
      onCollision?: "fail" | "keep_both";
    }
  ): Promise<WorkspaceEntryCopyResult> {
    return copyWorkspaceEntry(await this.target(workspaceId), input);
  }

  async listSkills(workspaceId: string, runnerKind: AgentRunnerKind): Promise<WorkspaceSkill[]> {
    // The directories to scan and the token a composer inserts are descriptor
    // fields, so this reads what the runner itself would load rather than a
    // per-kind table that could drift from it.
    const descriptor = runnerDescriptor(runnerKind);
    const target = await this.target(workspaceId);
    return listWorkspaceSkills(target.workspaceRoot, descriptor);
  }

  async listFiles(
    workspaceId: string,
    input: { query?: string; limit?: number } = {}
  ): Promise<WorkspaceFileIndexSnapshot> {
    const target = await this.target(workspaceId);
    const index = await this.fileIndex.get(workspaceId, target.workspaceRoot);
    return listIndexedFiles(target, index, input);
  }

  async searchFiles(
    workspaceId: string,
    input: { query: string; matchCase?: boolean; wholeWord?: boolean; include?: string; limit?: number }
  ): Promise<WorkspaceSearchSnapshot> {
    const target = await this.target(workspaceId);
    const index = await this.fileIndex.get(workspaceId, target.workspaceRoot);
    return searchIndexedFiles(target, index, input);
  }

  /**
   * Drops a workspace's cached path index (or every workspace's, with no
   * argument) for the callers that change what it should contain: a create,
   * rename, move, copy, deletion, branch switch, or unregistration.
   */
  invalidateFileIndex(workspaceId?: string): void {
    this.fileIndex.invalidate(workspaceId);
  }

  async promptWithContext(workspaceId: string, message: string, paths: string[] = []): Promise<string> {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (uniquePaths.length === 0) return message;
    return buildPromptWithContext(await this.target(workspaceId), message, uniquePaths);
  }

  /**
   * The registered workspace every bounded operation runs against. Only id ->
   * path resolution is needed for read/write bounding; skipping the git
   * snapshot refresh keeps tree/preview/write requests off the git hot path.
   */
  private async target(workspaceId: string): Promise<WorkspaceTarget> {
    const workspace = await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new WorkspaceExplorerError("Workspace is not registered", 404);
    }
    return { workspaceId, workspacePath: workspace.path, workspaceRoot: await realpath(workspace.path) };
  }
}
