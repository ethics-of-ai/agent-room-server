import type {
  LocalWorkspace,
  LocalWorkspaceGitOperation,
  LocalWorkspaceGitOperationResult
} from "../domain/models";
import {
  gitErrorMessage,
  isRenamedEntry,
  isStagedEntry,
  isUntrackedEntry,
  type GitChangedEntry
} from "./LocalWorkspaceGit";
import { LocalWorkspaceRegistryError, type LocalWorkspaceRegistry } from "./LocalWorkspaceRegistry";
import { indexableRelativePath } from "./WorkspaceExplorer";

export class WorkspaceGitServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface WorkspaceGitPathsInput {
  paths?: string[];
  /** Act on every changed path git reports instead of a caller-supplied list. */
  all?: boolean;
}

export interface WorkspaceGitCommitInput {
  message: string;
  /** Stage every changed path first, so "commit everything" is one request. */
  stageAll?: boolean;
}

export interface WorkspaceGitPushInput {
  /** Publish a branch that has no upstream yet (`push --set-upstream`). */
  setUpstream?: boolean;
}

export interface WorkspaceGitCreateBranchInput {
  branch: string;
}

interface ResolvedPaths {
  accepted: string[];
  skipped: string[];
}

/**
 * The fixed git operations a client can ask the backend to run in a registered
 * workspace: stage, unstage, discard, commit, fetch, pull, push, and branch
 * creation. It is the mutating counterpart to the read-only Git status and
 * baseline routes, and it is deliberately narrow:
 *
 * - Every command is a fixed argv assembled in `LocalWorkspaceGit`. A caller
 *   contributes pathspecs and a commit message, never a flag, a refspec, or a
 *   remote — so this is not a shell and cannot become one.
 * - Every caller-supplied path goes through `indexableRelativePath`, the same
 *   filter the tree read and file index use, so a `.env`, key file, or
 *   generated-directory path can be neither staged nor discarded here.
 * - Nothing rewrites history: no amend, no reset, no rebase, and no forced push.
 *   Pull is fast-forward only, because a client with no conflict-resolution
 *   surface should not be able to create a conflicted worktree.
 *
 * See docs/safety/TRUST_AND_SAFETY.md.
 */
export class WorkspaceGitService {
  constructor(private readonly registry: LocalWorkspaceRegistry) {}

  async stage(workspaceId: string, input: WorkspaceGitPathsInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const resolved = input.all
      ? await this.changedPathsForStaging(workspace)
      : await this.changedPathsForExplicitOperation(workspace, input.paths);

    if (resolved.accepted.length > 0) {
      await this.run("Git stage failed", () => this.registry.git.stagePaths(workspace.path, resolved.accepted));
    }
    return this.result(workspaceId, "stage", resolved);
  }

  async unstage(workspaceId: string, input: WorkspaceGitPathsInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const resolved = input.all
      ? await this.changedPathsForStaging(workspace, isStagedEntry)
      : await this.changedPathsForExplicitOperation(workspace, input.paths, isStagedEntry);

    if (resolved.accepted.length > 0) {
      const hasCommits = await this.registry.git.hasCommits(workspace.path);
      await this.run("Git unstage failed", () =>
        this.registry.git.unstagePaths(workspace.path, resolved.accepted, hasCommits)
      );
    }
    return this.result(workspaceId, "unstage", resolved);
  }

  /**
   * Reverts each path to its HEAD content, deleting it when HEAD has no such
   * file. This is destructive and irreversible — the discarded work is not
   * stashed anywhere — so it acts only on paths the caller named explicitly.
   */
  async discard(workspaceId: string, input: WorkspaceGitPathsInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const resolved = resolveExplicitPaths(input.paths);

    const entries = await this.readChangedEntries(workspace);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const restore: string[] = [];
    const unstage: string[] = [];
    const remove: string[] = [];

    for (const path of resolved.accepted) {
      const entry = byPath.get(path);
      // A path with no pending change has nothing to discard; treat it as a
      // no-op rather than an error so a stale client list stays harmless.
      if (!entry) continue;
      if (isUntrackedEntry(entry)) {
        // Never entered the index, so `clean` alone removes it. Unstaging it
        // would fail the whole batch on a pathspec git does not know.
        remove.push(path);
        continue;
      }
      if (entry.oldPath && isRenamedEntry(entry)) {
        // A staged rename is two paths: bring the original back from HEAD and
        // drop the new one, which HEAD does not have.
        restore.push(entry.oldPath);
        unstage.push(path);
        remove.push(path);
        continue;
      }
      if (entry.indexStatus === "A") {
        // Added to the index but absent from HEAD, so "revert to HEAD" means
        // unstaging it and deleting the file.
        unstage.push(path);
        remove.push(path);
        continue;
      }
      restore.push(path);
    }

    await this.run("Git discard failed", async () => {
      if (restore.length > 0) {
        await this.registry.git.restoreFromHead(workspace.path, restore);
      }
      if (unstage.length > 0) {
        const hasCommits = await this.registry.git.hasCommits(workspace.path);
        // `clean` only removes files git does not track, so anything in the
        // index has to leave it first.
        await this.registry.git.unstagePaths(workspace.path, unstage, hasCommits);
      }
      if (remove.length > 0) {
        await this.registry.git.cleanPaths(workspace.path, remove);
      }
    });

    return this.result(workspaceId, "discard", resolved);
  }

  async commit(workspaceId: string, input: WorkspaceGitCommitInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const message = input.message.trim();
    if (!message) {
      throw new WorkspaceGitServiceError("Commit message is required");
    }

    let skipped: string[] = [];
    if (input.stageAll) {
      const resolved = await this.changedPathsForStaging(workspace);
      skipped = resolved.skipped;
      if (resolved.accepted.length > 0) {
        await this.run("Git stage failed", () => this.registry.git.stagePaths(workspace.path, resolved.accepted));
      }
    }

    // `git commit` records the repository's entire index, including paths that
    // may have been staged outside AgentRoom. Re-check that complete staged set
    // immediately before committing so an externally staged secret, generated
    // file, or path outside a registered subdirectory cannot ride along.
    await this.assertSafeStagedIndex(workspace);

    const commit = await this.run("Git commit failed", () => this.registry.git.commit(workspace.path, message));
    // The committed set is already reflected in the refreshed status, so a commit
    // reports the commit itself rather than repeating the path list.
    const result = await this.result(workspaceId, "commit", { accepted: [], skipped });
    return { ...result, commit: commit.commit, commitSubject: commit.subject };
  }

  async fetch(workspaceId: string): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    await this.requireRemote(workspace);
    await this.run("Git fetch failed", () => this.registry.git.fetch(workspace.path, undefined));
    return this.result(workspaceId, "fetch", { accepted: [], skipped: [] });
  }

  async pull(workspaceId: string): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    await this.requireRemote(workspace);
    await this.run("Git pull failed", () => this.registry.git.pullFastForward(workspace.path));
    // No `previousBranch`: a fast-forward moves the branch, it does not change
    // which branch is checked out.
    return this.result(workspaceId, "pull", { accepted: [], skipped: [] });
  }

  async push(workspaceId: string, input: WorkspaceGitPushInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId, { freshGit: true });
    const remotes = await this.requireRemote(workspace);
    const branch = await this.registry.git.currentBranch(workspace.path);
    if (!branch) {
      throw new WorkspaceGitServiceError("Workspace is not on a branch; check out a branch before pushing");
    }

    // Publish only when asked to, or when the branch has no upstream to push to.
    const publishing = input.setUpstream === true || !workspace.git.upstream;
    const remote = publishing ? await this.resolvePushRemote(workspace, branch, remotes) : undefined;
    await this.run("Git push failed", () =>
      this.registry.git.push(workspace.path, remote ? { remote, branch } : undefined)
    );

    const result = await this.result(workspaceId, "push", { accepted: [], skipped: [] });
    return { ...result, branch, ...(remote ? { remote } : {}) };
  }

  async createBranch(
    workspaceId: string,
    input: WorkspaceGitCreateBranchInput
  ): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId, { freshGit: true });
    const branch = input.branch.trim();
    if (!branch) {
      throw new WorkspaceGitServiceError("Git branch is required");
    }
    try {
      await this.registry.git.validateBranchName(workspace.path, branch);
    } catch {
      throw new WorkspaceGitServiceError("Invalid Git branch name");
    }
    if ((workspace.git.branches ?? []).some((candidate) => candidate.name === branch)) {
      throw new WorkspaceGitServiceError("Git branch already exists", 409);
    }

    const previousBranch = workspace.git.branch;
    // `switch --create` carries uncommitted work onto the new branch, which is the
    // point of branching mid-change; unlike a plain switch it needs no clean tree.
    await this.run("Git branch creation failed", () => this.registry.git.createBranch(workspace.path, branch), 409);

    const result = await this.result(workspaceId, "create_branch", { accepted: [], skipped: [] });
    return { ...result, branch, ...(previousBranch ? { previousBranch } : {}) };
  }

  /**
   * Resolves the workspace and asserts it is a repository.
   *
   * `freshGit` is only for the operations that *read* the snapshot — push needs
   * the current upstream, branch creation needs the branch list. The rest need
   * nothing from it but "is this a repository", which one `rev-parse` answers,
   * so they skip the five-command refresh that would be thrown away by the
   * post-operation refresh anyway.
   */
  private async repositoryWorkspace(
    workspaceId: string,
    options: { freshGit?: boolean } = {}
  ): Promise<LocalWorkspace> {
    const workspace = options.freshGit
      ? await this.registry.findById(workspaceId)
      : await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    }
    const isRepository = options.freshGit
      ? workspace.git.isRepository
      : await this.registry.git.isRepository(workspace.path);
    if (!isRepository) {
      throw new WorkspaceGitServiceError("Workspace is not a Git repository");
    }
    return workspace;
  }

  private async requireRemote(workspace: LocalWorkspace): Promise<string[]> {
    const remotes = await this.registry.git.remotes(workspace.path);
    if (remotes.length === 0) {
      throw new WorkspaceGitServiceError("Workspace has no Git remote configured");
    }
    return remotes;
  }

  private async resolvePushRemote(workspace: LocalWorkspace, branch: string, remotes: string[]): Promise<string> {
    const configured = await this.registry.git.branchRemote(workspace.path, branch);
    if (configured && remotes.includes(configured)) return configured;
    if (remotes.includes("origin")) return "origin";
    if (remotes.length === 1) return remotes[0];
    throw new WorkspaceGitServiceError(
      "Workspace has several Git remotes and no upstream for this branch; set one with git before publishing"
    );
  }

  /**
   * Every changed path git reports, filtered through the shared workspace path
   * filter. Deliberately built from an uncapped porcelain read rather than the
   * 200-file status projection, so "stage all" cannot silently miss files in a
   * very dirty tree.
   */
  private async changedPathsForStaging(
    workspace: LocalWorkspace,
    predicate?: (entry: GitChangedEntry) => boolean
  ): Promise<ResolvedPaths> {
    const entries = await this.readChangedEntries(workspace);
    const accepted: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (predicate && !predicate(entry)) continue;
      // A rename's original path has to move too, or staging the pair leaves the
      // deletion behind.
      for (const candidate of entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const safePath = indexableRelativePath(candidate);
        if (safePath) accepted.push(safePath);
        else skipped.push(candidate);
      }
    }
    return { accepted, skipped };
  }

  /**
   * Resolves caller-supplied paths against Git's exact changed-file entries.
   * Merely passing the lexical filter is insufficient: `git add src` recurses
   * through a directory and could otherwise stage a refused `src/.env` below
   * it. Expanding renames here also keeps both sides of the change together.
   */
  private async changedPathsForExplicitOperation(
    workspace: LocalWorkspace,
    paths: string[] | undefined,
    predicate?: (entry: GitChangedEntry) => boolean
  ): Promise<ResolvedPaths> {
    const resolved = resolveExplicitPaths(paths);
    const entries = await this.readChangedEntries(workspace);
    const byPath = new Map<string, GitChangedEntry>();
    for (const entry of entries) {
      byPath.set(entry.path, entry);
      if (entry.oldPath) byPath.set(entry.oldPath, entry);
    }

    const accepted: string[] = [];
    const seen = new Set<string>();
    for (const requestedPath of resolved.accepted) {
      const entry = byPath.get(requestedPath);
      if (!entry || (predicate && !predicate(entry))) {
        throw new WorkspaceGitServiceError("Path is not an eligible changed file", 409);
      }
      for (const candidate of entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]) {
        if (seen.has(candidate)) continue;
        const safePath = indexableRelativePath(candidate);
        if (!safePath) {
          throw new WorkspaceGitServiceError(
            "Changed path is outside the workspace, secret-named, or in a generated directory",
            415
          );
        }
        seen.add(candidate);
        accepted.push(safePath);
      }
    }
    return { accepted, skipped: [] };
  }

  private async assertSafeStagedIndex(workspace: LocalWorkspace): Promise<void> {
    const paths = await this.run("Git staged-index read failed", () => this.registry.git.stagedPaths(workspace.path));
    for (const candidate of paths) {
      if (!candidate.withinWorkspace || !indexableRelativePath(candidate.path)) {
        throw new WorkspaceGitServiceError(
          "Git index contains a path outside the workspace, secret-named, or in a generated directory; unstage it before committing",
          415
        );
      }
    }
  }

  private async readChangedEntries(workspace: LocalWorkspace): Promise<GitChangedEntry[]> {
    return this.run("Git status read failed", () => this.registry.git.changedEntries(workspace.path));
  }

  private async result(
    workspaceId: string,
    operation: LocalWorkspaceGitOperation,
    resolved: ResolvedPaths
  ): Promise<LocalWorkspaceGitOperationResult> {
    // Refresh past the snapshot cache so the workspace and status a client gets
    // back describe the tree after its own command, not before it.
    const workspace = await this.registry.refreshWorkspaceGit(workspaceId);
    const status = await this.registry.gitStatus(workspaceId);
    return {
      workspaceId,
      operation,
      workspace,
      status,
      ...(resolved.accepted.length > 0 ? { paths: resolved.accepted } : {}),
      ...(resolved.skipped.length > 0 ? { skippedPaths: resolved.skipped } : {})
    } satisfies LocalWorkspaceGitOperationResult;
  }

  private async run<T>(fallbackMessage: string, operation: () => Promise<T>, statusCode = 409): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // git's own stderr is the useful diagnostic here (identity unset, non-fast-
      // forward, no upstream, hook rejection), and `gitErrorMessage` strips URL
      // credentials and labelled secrets from it first.
      throw new WorkspaceGitServiceError(gitErrorMessage(error, fallbackMessage), statusCode);
    }
  }
}

function resolveExplicitPaths(paths: string[] | undefined): ResolvedPaths {
  if (!paths || paths.length === 0) {
    throw new WorkspaceGitServiceError("At least one workspace-relative path is required");
  }
  const accepted: string[] = [];
  for (const raw of paths) {
    const safePath = indexableRelativePath(raw);
    // Explicitly named paths are all-or-nothing: silently dropping one would let
    // a client believe it staged or discarded something it did not.
    if (!safePath) {
      throw new WorkspaceGitServiceError(
        "Path is outside the workspace, secret-named, or in a generated directory",
        415
      );
    }
    accepted.push(safePath);
  }
  return { accepted: [...new Set(accepted)], skipped: [] };
}
