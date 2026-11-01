import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  managedWorktreeBranchPattern,
  managedWorktreeNamePattern,
  type LocalWorkspaceWorktree
} from "../domain/childThreads";
import type {
  LocalWorkspace,
  LocalWorkspaceGitOperation,
  LocalWorkspaceGitOperationResult
} from "../domain/models";
import { fullCommitIdPattern, gitErrorMessage, isStagedEntry, type GitChangedEntry } from "./LocalWorkspaceGit";
import { WorkspaceGitServiceError } from "./git/errors";
import { gitExitCode } from "./git/execution";
import {
  assertIndexableStagedPaths,
  planDiscardOperations,
  resolveExplicitPaths,
  selectAllChangedPaths,
  selectExplicitChangedPaths,
  type ResolvedPaths
} from "./git/pathSelection";
import { LocalWorkspaceRegistryError, type LocalWorkspaceRegistry } from "./LocalWorkspaceRegistry";

export { WorkspaceGitServiceError, type WorkspaceGitRefusalCode } from "./git/errors";

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

export type WorkspaceGitBranchDeleteResult = LocalWorkspaceGitOperationResult & {
  /** True when Git kept the branch because HEAD does not contain it; not an error. */
  branchKept: boolean;
};

interface LinkedChildWorktree {
  child: LocalWorkspace;
  parent: LocalWorkspace;
  worktree: LocalWorkspaceWorktree;
}

/**
 * The fixed git operations a client can ask the backend to run in a registered
 * workspace: stage, unstage, discard, commit, fetch, pull, push, and branch
 * creation, plus the five a child thread's worktree needs: add, remove, branch
 * delete, Land and Update. It is the mutating counterpart to the read-only Git
 * status and baseline routes, and it is deliberately narrow:
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

  // --- Child worktree operations ---------------------------------------------
  // The child-thread service is the only caller. It mints the worktree record;
  // these check its shapes anyway, so a bad record cannot become a Git argument.
  // Add, remove and branch delete run in the parent workspace and take the
  // record itself, because rollback runs them before the child is registered.
  // Land and Update read the record from the registered child.

  // Git creates the `-b` branch before the checkout and keeps it when the
  // checkout fails (a required filter that fails, or a timeout), so a failed
  // add deletes the branch it made. The branch is new, which the check before
  // the add makes sure of, and it sits at the base commit, so `-d` deletes it.
  async addWorktree(worktree: LocalWorkspaceWorktree): Promise<LocalWorkspaceGitOperationResult> {
    const parent = await this.worktreeParent(worktree);
    if (parent.kind === "managed_worktree") {
      throw new WorkspaceGitServiceError("A child worktree cannot have child worktrees", 409);
    }
    const { git } = this.registry;
    if (await git.branchExists(parent.path, worktree.branch)) {
      throw new WorkspaceGitServiceError("Git branch already exists", 409);
    }
    try {
      await this.run("Git worktree add failed", () =>
        git.addWorktree(parent.path, worktree.branch, worktree.worktreePath, worktree.baseCommit)
      );
    } catch (error) {
      await git.deleteMergedBranch(parent.path, worktree.branch).catch(() => undefined);
      throw error;
    }
    const result = await this.result(parent.id, "worktree_add", { accepted: [], skipped: [] });
    return { ...result, branch: worktree.branch, commit: worktree.baseCommit };
  }

  /**
   * Removes the worktree, or returns undefined when Git no longer records it:
   * someone ran `git worktree remove` or `prune` themselves, or an earlier
   * Close removed it and stopped before it finished. Either way nothing is left
   * for Git to remove, and a Close must still be able to finish.
   */
  async removeWorktree(worktree: LocalWorkspaceWorktree): Promise<LocalWorkspaceGitOperationResult | undefined> {
    const parent = await this.worktreeParent(worktree);
    try {
      await this.run("Git worktree remove failed", () => this.registry.git.removeWorktree(parent.path, worktree.worktreePath));
    } catch (error) {
      if (!(await this.gitRecordsWorktree(parent.path, worktree.worktreePath))) return undefined;
      throw error;
    }
    const result = await this.result(parent.id, "worktree_remove", { accepted: [], skipped: [] });
    return { ...result, branch: worktree.branch };
  }

  // Git exits 1 both for an unmerged branch and for one a worktree still has
  // checked out; either way the branch and its commits stay, which is the
  // outcome a caller reports rather than an error.
  async deleteMergedBranch(worktree: LocalWorkspaceWorktree): Promise<WorkspaceGitBranchDeleteResult> {
    const parent = await this.worktreeParent(worktree);
    let branchKept = false;
    try {
      await this.registry.git.deleteMergedBranch(parent.path, worktree.branch);
    } catch (error) {
      if (gitExitCode(error) !== 1) throw new WorkspaceGitServiceError(gitErrorMessage(error, "Git branch delete failed"), 409);
      branchKept = true;
    }
    const result = await this.result(parent.id, "branch_delete", { accepted: [], skipped: [] });
    return { ...result, branch: worktree.branch, branchKept };
  }

  /**
   * Fast-forwards whatever branch the parent checkout is on to the child's
   * branch. A detached parent refuses: the fast-forward would move a HEAD no
   * branch follows, and Close's `branch -d` would then delete the child's
   * branch while only that HEAD holds its commits.
   */
  async landChild(parentWorkspaceId: string, childWorkspaceId: string): Promise<LocalWorkspaceGitOperationResult> {
    const { parent, worktree } = await this.mergeableChild(childWorkspaceId, parentWorkspaceId);
    // Asked before the merge, because Git's exit 128 also covers a held
    // index.lock or a merge already in progress in the parent.
    if (!(await this.run("Git ancestry read failed", () => this.registry.git.headIsAncestorOf(parent.path, worktree.branch)))) {
      throw new WorkspaceGitServiceError("The parent branch has commits the child does not; update the child first", 409, "not_fast_forward");
    }
    try {
      await this.registry.git.mergeFastForward(parent.path, worktree.branch);
    } catch (error) {
      // Git exits 1 when a parent file is in the way, tracked or untracked,
      // and for other refusals such as a held index.lock, so the code comes
      // from the overlap itself.
      const inTheWay = gitExitCode(error) === 1 && (await this.parentChangesInTheWay(parent, worktree));
      throw new WorkspaceGitServiceError(gitErrorMessage(error, "Git fast-forward failed"), 409, inTheWay ? "parent_changes_in_the_way" : undefined);
    }
    const result = await this.result(parent.id, "merge_ff", { accepted: [], skipped: [] });
    const commit = await this.registry.git.headCommit(parent.path);
    return { ...result, branch: worktree.branch, ...(commit ? { commit } : {}) };
  }

  /**
   * Merges the parent checkout's current branch into the child's, aborting on
   * a conflict. A failure that leaves part of the merge in the worktree, such
   * as a timeout, refuses with `update_interrupted`: the worktree was clean,
   * so its changes are the merge's, and the person discards them.
   */
  async updateChildFromParent(childWorkspaceId: string): Promise<LocalWorkspaceGitOperationResult> {
    const { child, worktree, parentBranch } = await this.mergeableChild(childWorkspaceId);
    const interrupted = () => new WorkspaceGitServiceError(
      `Merging ${parentBranch} stopped part way; discard the changes it left in the child's worktree, then update again`,
      409,
      "update_interrupted"
    );
    let outcome: "merged" | "aborted" | "abort_failed";
    try {
      outcome = await this.run("Git merge failed", () => this.registry.git.mergeOrAbort(worktree.worktreePath, parentBranch));
    } catch (error) {
      const left = await this.registry.git.changedEntries(worktree.worktreePath).catch(() => []);
      throw left.length > 0 ? interrupted() : error;
    }
    if (outcome === "abort_failed") throw interrupted();
    if (outcome === "aborted") {
      throw new WorkspaceGitServiceError(
        `Merging ${parentBranch} conflicted, so AgentRoom aborted it and left the branch as it was`,
        409,
        "update_conflicted"
      );
    }
    const result = await this.result(child.id, "update_from_parent", { accepted: [], skipped: [] });
    const commit = await this.registry.git.headCommit(worktree.worktreePath);
    return { ...result, branch: worktree.branch, ...(commit ? { commit } : {}) };
  }

  /** Refuses a worktree with uncommitted changes, read from its root so a registered subdirectory is judged on everything. */
  async requireCleanWorktree(worktree: LocalWorkspaceWorktree): Promise<void> {
    const entries = await this.run("Git status read failed", () => this.registry.git.changedEntries(worktree.worktreePath));
    if (entries.length > 0) {
      throw new WorkspaceGitServiceError("The child worktree has uncommitted changes; commit or discard them first", 409, "child_dirty");
    }
  }

  /** Checks a worktree record's minted shapes and resolves the parent it names. */
  private async worktreeParent(worktree: LocalWorkspaceWorktree): Promise<LocalWorkspace> {
    const { branch, worktreePath, baseCommit, parentWorkspaceId } = worktree;
    if (!managedWorktreeBranchPattern.test(branch) || !fullCommitIdPattern.test(baseCommit)) {
      throw new WorkspaceGitServiceError("Invalid child worktree record");
    }
    if (!isAbsolute(worktreePath) || normalize(worktreePath) !== worktreePath || !managedWorktreeNamePattern.test(basename(worktreePath))) {
      throw new WorkspaceGitServiceError("Invalid child worktree record");
    }
    const root = this.registry.managedWorktreeRoot(parentWorkspaceId);
    const folder = dirname(worktreePath);
    if (folder !== root && folder !== (await realpath(root).catch(() => undefined))) {
      throw new WorkspaceGitServiceError("Child worktree path is outside AgentRoom's worktree folder");
    }
    const parent = await this.repositoryWorkspace(parentWorkspaceId);
    try {
      await this.registry.git.validateBranchName(parent.path, branch);
    } catch {
      throw new WorkspaceGitServiceError("Invalid Git branch name");
    }
    return parent;
  }

  // The common-dir check is what tells a child's worktree from a folder that
  // was deleted, or replaced by an unrelated repository, at the same path.
  private async linkedChildWorktree(childWorkspaceId: string): Promise<LinkedChildWorktree> {
    const child = await this.registry.findByIdWithoutGitRefresh(childWorkspaceId);
    if (!child) throw new LocalWorkspaceRegistryError("Workspace is not registered", 404);
    if (child.kind !== "managed_worktree" || !child.worktree) {
      throw new WorkspaceGitServiceError("Workspace is not a child worktree", 409, "child_not_linked");
    }
    const worktree = child.worktree;
    const parent = await this.worktreeParent(worktree);
    const [childCommonDir, parentCommonDir] = await Promise.all([
      this.commonDir(worktree.worktreePath),
      this.commonDir(parent.path)
    ]);
    if (!childCommonDir || childCommonDir !== parentCommonDir) {
      throw new WorkspaceGitServiceError(
        "The child worktree is missing or no longer belongs to the parent repository",
        409,
        "child_not_linked"
      );
    }
    return { child, parent, worktree };
  }

  /**
   * What Land and Update both need before they merge: a linked child, still
   * on its own branch, clean, with a parent checkout on a branch. A switch made
   * outside AgentRoom moves the worktree off its branch, and merging then
   * would carry the stale `agentroom/...` ref.
   */
  private async mergeableChild(
    childWorkspaceId: string,
    parentWorkspaceId?: string
  ): Promise<LinkedChildWorktree & { parentBranch: string }> {
    const linked = await this.linkedChildWorktree(childWorkspaceId);
    if (parentWorkspaceId !== undefined && linked.parent.id !== parentWorkspaceId) {
      throw new WorkspaceGitServiceError("Workspace is not this child's parent", 409, "child_not_linked");
    }
    const { git } = this.registry;
    if ((await git.currentBranch(linked.worktree.worktreePath)) !== linked.worktree.branch) {
      throw new WorkspaceGitServiceError("The child worktree is not on its own branch", 409, "child_not_linked");
    }
    const parentBranch = await git.currentBranch(linked.parent.path);
    if (!parentBranch) {
      throw new WorkspaceGitServiceError("The parent checkout is not on a branch", 409, "parent_detached");
    }
    await this.requireCleanWorktree(linked.worktree);
    return { ...linked, parentBranch };
  }

  /** Whether a changed or untracked parent file is one the fast-forward would write. */
  private async parentChangesInTheWay(parent: LocalWorkspace, worktree: LocalWorkspaceWorktree): Promise<boolean> {
    const { git } = this.registry;
    const [parentHead, childHead, dirty] = await Promise.all([
      git.headCommit(parent.path),
      git.headCommit(worktree.worktreePath),
      git.changedEntries(parent.path).catch(() => [])
    ]);
    if (!parentHead || !childHead || dirty.length === 0) return false;
    const incoming = await git.committedChanges(parent.path, parentHead, childHead).catch(() => undefined);
    const dirtyPaths = new Set(dirty.map((entry) => entry.path));
    return incoming?.files.some((file) => dirtyPaths.has(file.path)) ?? false;
  }

  private async commonDir(workspacePath: string): Promise<string | undefined> {
    const commonDir = await this.registry.git.gitCommonDir(workspacePath);
    return commonDir ? realpath(commonDir).catch(() => undefined) : undefined;
  }

  // Git records a worktree under its real path, and a deleted folder's real
  // path is its real parent folder plus its name.
  private async gitRecordsWorktree(repositoryPath: string, worktreePath: string): Promise<boolean> {
    const real = async (path: string) => join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
    const target = await real(worktreePath);
    const listed = await this.registry.git.worktreePaths(repositoryPath).catch(() => undefined);
    if (!listed) return true;
    for (const path of listed) if (path === worktreePath || (await real(path)) === target) return true;
    return false;
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
