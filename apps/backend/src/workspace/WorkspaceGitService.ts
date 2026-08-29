import type {
  LocalWorkspace,
  LocalWorkspaceGitOperation,
  LocalWorkspaceGitOperationResult
} from "../domain/models";
import { gitErrorMessage, isStagedEntry, type GitChangedEntry } from "./LocalWorkspaceGit";
import { WorkspaceGitServiceError } from "./git/errors";
import {
  assertIndexableStagedPaths,
  planDiscardOperations,
  resolveExplicitPaths,
  selectAllChangedPaths,
  selectExplicitChangedPaths,
  type ResolvedPaths
} from "./git/pathSelection";
import { LocalWorkspaceRegistryError, type LocalWorkspaceRegistry } from "./LocalWorkspaceRegistry";

export { WorkspaceGitServiceError } from "./git/errors";

export interface WorkspaceGitPathsInput {
  paths?: string[];
  all?: boolean;
}

export interface WorkspaceGitCommitInput {
  message: string;
  stageAll?: boolean;
}

export interface WorkspaceGitPushInput {
  setUpstream?: boolean;
}

export interface WorkspaceGitCreateBranchInput {
  branch: string;
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
 * - Which paths an operation may touch is decided in `./git/pathSelection.ts`,
 *   where every caller-supplied path goes through `indexableRelativePath`, the
 *   same filter the tree read and file index use.
 * - Nothing rewrites history: no amend, no reset, no rebase, and no forced push.
 *   Pull is fast-forward only, because a client with no conflict-resolution
 *   surface should not be able to create a conflicted worktree.
 *
 * What lives here is the order the fixed commands run in, and the mapping from
 * a git failure to a refusal a route can answer with.
 *
 * See docs/safety/TRUST_AND_SAFETY.md.
 */
export class WorkspaceGitService {
  constructor(private readonly registry: LocalWorkspaceRegistry) {}

  async stage(workspaceId: string, input: WorkspaceGitPathsInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const resolved = input.all
      ? selectAllChangedPaths(await this.readChangedEntries(workspace))
      : await selectExplicitChangedPaths(input.paths, () => this.readChangedEntries(workspace));

    if (resolved.accepted.length > 0) {
      await this.run("Git stage failed", () => this.registry.git.stagePaths(workspace.path, resolved.accepted));
    }
    return this.result(workspaceId, "stage", resolved);
  }

  async unstage(workspaceId: string, input: WorkspaceGitPathsInput): Promise<LocalWorkspaceGitOperationResult> {
    const workspace = await this.repositoryWorkspace(workspaceId);
    const resolved = input.all
      ? selectAllChangedPaths(await this.readChangedEntries(workspace), isStagedEntry)
      : await selectExplicitChangedPaths(input.paths, () => this.readChangedEntries(workspace), isStagedEntry);

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
    const plan = planDiscardOperations(await this.readChangedEntries(workspace), resolved.accepted);

    await this.run("Git discard failed", async () => {
      if (plan.restore.length > 0) {
        await this.registry.git.restoreFromHead(workspace.path, plan.restore);
      }
      if (plan.unstage.length > 0) {
        const hasCommits = await this.registry.git.hasCommits(workspace.path);
        // `clean` only removes files git does not track, so anything in the
        // index has to leave it first.
        await this.registry.git.unstagePaths(workspace.path, plan.unstage, hasCommits);
      }
      if (plan.remove.length > 0) {
        await this.registry.git.cleanPaths(workspace.path, plan.remove);
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
      const resolved = selectAllChangedPaths(await this.readChangedEntries(workspace));
      skipped = resolved.skipped;
      if (resolved.accepted.length > 0) {
        await this.run("Git stage failed", () => this.registry.git.stagePaths(workspace.path, resolved.accepted));
      }
    }

    // `git commit` records the repository's entire index, including paths that
    // may have been staged outside AgentRoom. Re-check that complete staged set
    // immediately before committing so an externally staged secret, generated
    // file, or path outside a registered subdirectory cannot ride along.
    assertIndexableStagedPaths(
      await this.run("Git staged-index read failed", () => this.registry.git.stagedPaths(workspace.path))
    );

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
