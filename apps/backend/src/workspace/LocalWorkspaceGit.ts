import type { LocalWorkspaceGitChangedFile, LocalWorkspaceGitStatus, LocalWorkspaceGitSnapshot } from "../domain/models";
import { GitHistoryReader } from "./git/historyReads";
import {
  gitCommandEnv,
  gitExitCode,
  gitNetworkEnv,
  gitReadEnv,
  literalPathspec,
  optionalGitValue,
  type GitBlobExecutor,
  type GitCommandExecutor
} from "./git/execution";
import {
  parseRemoteNames,
  readGitFileAtHead,
  readGitSnapshot,
  type GitFileAtHeadResult
} from "./git/repositoryReads";
import {
  cleanNonRepositoryStatus,
  gitStatusCounts,
  gitStatusFiles,
  isStagedEntry,
  maxGitStatusFiles,
  parseNameStatus,
  parseNumstat,
  parsePorcelainStatus,
  stripTrailingLineEnding,
  workspaceRelativeGitPath,
  type GitChangedEntry
} from "./git/statusParsing";

// The fixed Git surface: one class of argv-only invocations over a registered
// workspace, with no shell anywhere. How a command runs lives in
// `./git/execution.ts`, what its output means lives in `./git/statusParsing.ts`,
// and what may be run at all lives here. Nothing below assembles a command from
// caller text: a caller contributes pathspecs and a commit message, never a
// flag, a refspec, or a ref. The backend mints the branch, path and commit a
// child worktree operation names. See
// `docs/safety/TRUST_AND_SAFETY.md` (*Mutating Git operations*).

export {
  defaultGitBlobExecutor,
  defaultGitExecutor,
  gitErrorMessage,
  type GitBlobExecutor,
  type GitCommandExecutor
} from "./git/execution";
export { isRenamedEntry, isStagedEntry, isUntrackedEntry, type GitChangedEntry } from "./git/statusParsing";
export { type GitFileAtHeadResult } from "./git/repositoryReads";

// Upper bound on how many pathspecs go into one `git` invocation. A very dirty
// tree can hold more changed paths than an argv can carry, so path-taking
// operations run in chunks instead of failing with E2BIG.
const maxPathspecsPerInvocation = 200;
/** Upper bound the commit route enforces on an incoming message. */
export const maxCommitMessageChars = 5000;

export interface GitListFilesResult {
  /** False for a non-repository workspace (or when git is unavailable); callers fall back to a filesystem walk. */
  isRepository: boolean;
  /** Repository-tracked and untracked-but-not-ignored paths, relative to the registered workspace directory. */
  paths: string[];
  /** True when the enumeration hit `maxPaths` and more paths existed. */
  truncated: boolean;
}

export interface GitStagedPath {
  /** Path relative to the registered workspace when it lies inside it. */
  path: string;
  withinWorkspace: boolean;
}

/** What the commits after a turn-start commit changed inside the registered subtree. */
export interface GitCommittedChanges {
  files: LocalWorkspaceGitChangedFile[];
  truncated: boolean;
}

/** Tracked changes from a base commit to the working tree, inside the registered subtree. */
export interface GitDiffSinceCommit {
  /** Per-file line counts, capped like `status()`; a binary file has none. */
  files: Array<{ path: string; additions?: number; deletions?: number }>;
  truncated: boolean;
  /** Totals over every changed file, past the cap. */
  fileCount: number;
  insertions: number;
  deletions: number;
}

export const fullCommitIdPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Git knows the empty tree in every repository without storing it, under the
// SHA-1 or SHA-256 id that matches the repository's object format.
const emptyTreeIds = {
  40: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  64: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
} as const;

export interface GitCommitResult {
  commit: string;
  subject: string;
}

/** Set only when publishing a branch that has no upstream yet. */
export interface GitPushTarget {
  remote: string;
  branch: string;
}

export class LocalWorkspaceGit {
  readonly historyReader: GitHistoryReader;
  constructor(
    private readonly runGit: GitCommandExecutor,
    private readonly runGitBlob: GitBlobExecutor,
    /**
     * Executor for the three operations that talk to a remote. Separate from
     * `runGit` only so those can carry a longer timeout than the local-command
     * one — a fetch over a slow link is not a hung command.
     */
    private readonly runGitNetwork: GitCommandExecutor = runGit
  ) {
    this.historyReader = new GitHistoryReader(runGit, runGitBlob);
  }

  async snapshot(workspacePath: string): Promise<LocalWorkspaceGitSnapshot> {
    try {
      if (!(await this.isInsideWorkTree(workspacePath))) return { isRepository: false };
      return await readGitSnapshot((args) => this.tryGit(workspacePath, args));
    } catch {
      return { isRepository: false };
    }
  }

  async currentBranch(workspacePath: string): Promise<string | undefined> {
    return optionalGitValue(await this.tryGit(workspacePath, ["branch", "--show-current"]));
  }

  /** The full id of the commit HEAD names; undefined on an unborn branch or outside a repository. */
  async headCommit(workspacePath: string): Promise<string | undefined> {
    return optionalGitValue(await this.tryGit(workspacePath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]));
  }

  /**
   * The Git directory that holds this checkout's HEAD, which every workspace
   * registered inside the checkout shares and a linked worktree does not.
   * Undefined outside a repository.
   */
  async checkoutGitDir(workspacePath: string): Promise<string | undefined> {
    return optionalGitValue(await this.tryGit(workspacePath, ["rev-parse", "--absolute-git-dir"]));
  }

  // Fixed read of what the commits from `fromCommit` to `toCommit` changed inside
  // the registered subtree, capped like `status()`. Both are only ever ids
  // `headCommit` returned, never caller text, and are checked as such anyway.
  // With no `fromCommit` (the turn started on an unborn branch) the range starts
  // at the empty tree, so a repository's first commit lists every file it adds.
  // Naming the end commit keeps both reads on one range if HEAD moves between
  // them, and the trailing `--` keeps a tracked file from being read as a
  // revision. Renames split into a delete and an add so the two outputs pair
  // path for path. A failed read throws: the caller cannot treat it as empty.
  async committedChanges(workspacePath: string, fromCommit: string | undefined, toCommit: string): Promise<GitCommittedChanges> {
    assertFullCommitId(toCommit);
    if (fromCommit !== undefined) assertFullCommitId(fromCommit);
    const from = fromCommit ?? emptyTreeIds[toCommit.length as keyof typeof emptyTreeIds];
    const range = ["--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--relative", from, toCommit, "--"];
    const nameStatus = await this.runGit(workspacePath, ["diff", "--name-status", ...range], gitReadEnv());
    const numstat = await this.runGit(workspacePath, ["diff", "--numstat", ...range], gitReadEnv());
    const files = gitStatusFiles(parseNameStatus(nameStatus.stdout), "", numstat.stdout);
    return { files: files.slice(0, maxGitStatusFiles), truncated: files.length > maxGitStatusFiles };
  }

  // Fixed reads behind a child thread's summary. `baseCommit` is only ever an
  // id `headCommit` returned, checked as such. Both throw on a failed read.
  async commitsSince(workspacePath: string, baseCommit: string): Promise<number> {
    assertFullCommitId(baseCommit);
    const { stdout } = await this.runGit(workspacePath, ["rev-list", "--count", `${baseCommit}..HEAD`], gitReadEnv());
    return Number.parseInt(stdout.trim(), 10) || 0;
  }

  // One commit and no second revision compares against the working tree, so a
  // child's uncommitted tracked edits count too. Untracked files come from
  // `status()`. Renames split into a delete and an add, as in `committedChanges`.
  // Plumbing `diff-index`, because porcelain `git diff` against the working
  // tree rewrites the index under `index.lock` even with optional locks off.
  async diffSinceCommit(workspacePath: string, baseCommit: string): Promise<GitDiffSinceCommit> {
    assertFullCommitId(baseCommit);
    const { stdout } = await this.runGit(
      workspacePath,
      ["diff-index", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", baseCommit, "--"],
      gitReadEnv()
    );
    const files = parseNumstat(stdout).map(({ path, additions, deletions }) => ({
      path,
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions })
    }));
    return {
      files: files.slice(0, maxGitStatusFiles),
      truncated: files.length > maxGitStatusFiles,
      fileCount: files.length,
      insertions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
    };
  }

  /**
   * The repository's shared Git directory, which a linked worktree has in
   * common with the checkout it was added from. Undefined outside a repository,
   * including for a worktree whose folder is gone.
   */
  async gitCommonDir(workspacePath: string): Promise<string | undefined> {
    return optionalGitValue(await this.tryGit(workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  }

  /** Where the workspace sits inside its checkout: `""` at the root, else `sub/dir/`. Throws on a failed read. */
  async checkoutPrefix(workspacePath: string): Promise<string> {
    return stripTrailingLineEnding((await this.runGit(workspacePath, ["rev-parse", "--show-prefix"], gitReadEnv())).stdout);
  }

  /** One-subprocess repository check, so an operation can reject a non-repository cleanly. */
  async isRepository(workspacePath: string): Promise<boolean> {
    return this.isInsideWorkTree(workspacePath);
  }

  async validateBranchName(workspacePath: string, branch: string): Promise<void> {
    await this.runGit(workspacePath, ["check-ref-format", "--branch", branch], gitCommandEnv());
  }

  async switchBranch(workspacePath: string, branch: string): Promise<void> {
    await this.runGit(workspacePath, ["switch", "--", branch], gitCommandEnv());
  }

  // --- Fixed mutating operations ---------------------------------------------
  // Every one below is a fixed argv with no shell and no caller-supplied flags:
  // the caller contributes pathspecs (already lexically bounded and secret-name
  // filtered by WorkspaceGitService) and a commit message, never an option. Each
  // pathspec is prefixed `:(literal)` so a path that begins with `:` is read as a
  // path and never as git pathspec magic.

  async createBranch(workspacePath: string, branch: string): Promise<void> {
    await this.runGit(workspacePath, ["switch", "--create", branch], gitCommandEnv());
  }

  /** Raw, uncapped porcelain status. Unlike `status()` this keeps the index/worktree letters. */
  async changedEntries(workspacePath: string): Promise<GitChangedEntry[]> {
    // Mutations make safety decisions from this status. A failed read must
    // therefore fail the operation, not look like an empty (and safe) index.
    const [{ stdout: porcelain }, { stdout: prefixOutput }] = await Promise.all([
      this.runGit(
        workspacePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
        gitReadEnv()
      ),
      this.runGit(workspacePath, ["rev-parse", "--show-prefix"], gitReadEnv())
    ]);
    const prefix = stripTrailingLineEnding(prefixOutput);
    return parsePorcelainStatus(porcelain).flatMap((entry) => {
      const path = workspaceRelativeGitPath(entry.path, prefix);
      const oldPath = entry.oldPath ? workspaceRelativeGitPath(entry.oldPath, prefix) : undefined;
      // A cross-boundary rename cannot be represented as a wholly workspace-
      // relative operation. Leave it for the full-index commit guard to reject.
      if (!path || (entry.oldPath && !oldPath)) return [];
      return [{ ...entry, path, ...(oldPath ? { oldPath } : {}) }];
    });
  }

  /**
   * Every path currently staged in the repository index, including paths
   * outside a registered subdirectory. This intentionally has broader scope
   * than `changedEntries`; `git commit` has that same repository-wide scope.
   */
  async stagedPaths(workspacePath: string): Promise<GitStagedPath[]> {
    const [{ stdout: porcelain }, { stdout: prefixOutput }] = await Promise.all([
      this.runGit(
        workspacePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        gitReadEnv()
      ),
      this.runGit(workspacePath, ["rev-parse", "--show-prefix"], gitReadEnv())
    ]);
    const prefix = stripTrailingLineEnding(prefixOutput);
    const paths: GitStagedPath[] = [];
    const seen = new Set<string>();
    for (const entry of parsePorcelainStatus(porcelain)) {
      if (!isStagedEntry(entry)) continue;
      for (const repositoryPath of entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]) {
        if (seen.has(repositoryPath)) continue;
        seen.add(repositoryPath);
        const relativePath = workspaceRelativeGitPath(repositoryPath, prefix);
        paths.push({
          path: relativePath ?? repositoryPath,
          withinWorkspace: relativePath !== undefined
        });
      }
    }
    return paths;
  }

  /** False for a repository whose HEAD is unborn (freshly `git init`, no commit yet). */
  async hasCommits(workspacePath: string): Promise<boolean> {
    const output = await this.tryGit(workspacePath, ["rev-parse", "--verify", "HEAD"]);
    return Boolean(output?.trim());
  }

  async stagePaths(workspacePath: string, relPaths: string[]): Promise<void> {
    // `add` records deletions as well as content, so one call covers modified,
    // deleted, untracked, and conflicted paths alike.
    await this.runPathspecBatches(workspacePath, ["add", "--"], relPaths);
  }

  async unstagePaths(workspacePath: string, relPaths: string[], hasCommits: boolean): Promise<void> {
    // `restore --staged` resolves paths against HEAD, so an unborn HEAD needs the
    // pre-`restore` spelling instead of failing with "could not resolve HEAD".
    const argv = hasCommits ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "--"];
    await this.runPathspecBatches(workspacePath, argv, relPaths);
  }

  /** Resets both the index entry and the working-tree file to their HEAD content. */
  async restoreFromHead(workspacePath: string, relPaths: string[]): Promise<void> {
    await this.runPathspecBatches(workspacePath, ["restore", "--source=HEAD", "--staged", "--worktree", "--"], relPaths);
  }

  /** Deletes untracked files. `-f` without `-d` keeps this to files, never directories. */
  async cleanPaths(workspacePath: string, relPaths: string[]): Promise<void> {
    await this.runPathspecBatches(workspacePath, ["clean", "-f", "--"], relPaths);
  }

  // Commits whatever is staged. The workspace's own `pre-commit`/`commit-msg`
  // hooks run (this deliberately does not pass `--no-verify`), which is the same
  // committed-configuration trust the registered workspace already carries for
  // runner sessions.
  async commit(workspacePath: string, message: string): Promise<GitCommitResult> {
    await this.runGit(workspacePath, ["commit", "-m", message], gitCommandEnv());
    const described = (await this.tryGit(workspacePath, ["log", "-1", "--format=%H%x00%s"]))?.trim() ?? "";
    const [commit = "", subject = ""] = described.split("\0");
    return { commit: commit.trim(), subject: subject.trim() };
  }

  // --- Child worktree operations ---------------------------------------------
  // The child-thread service mints every branch, worktree path and base commit
  // passed here; none is caller text, and WorkspaceGitService checks their
  // shapes first. Each runs in the parent workspace except `mergeOrAbort`,
  // which runs in the child's worktree. Merge hooks run, as commit hooks do.

  async addWorktree(workspacePath: string, branch: string, worktreePath: string, baseCommit: string): Promise<void> {
    await this.runGit(workspacePath, ["worktree", "add", "-b", branch, "--", worktreePath, baseCommit], gitCommandEnv());
  }

  // Never `--force`: Git refuses a worktree that holds modified or untracked
  // files. It removes one holding only ignored files, and on a folder deleted
  // outside Git it succeeds and clears its own record. A path Git no longer
  // lists at all exits 128.
  async removeWorktree(workspacePath: string, worktreePath: string): Promise<void> {
    await this.runGit(workspacePath, ["worktree", "remove", "--", worktreePath], gitCommandEnv());
  }

  /** Every worktree path Git records for this repository, the main checkout included, as Git stores them. Throws on a failed read. */
  async worktreePaths(workspacePath: string): Promise<string[]> {
    const { stdout } = await this.runGit(workspacePath, ["worktree", "list", "--porcelain", "-z"], gitReadEnv());
    return stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
  }

  async branchExists(workspacePath: string, branch: string): Promise<boolean> {
    return (await this.tryGit(workspacePath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== undefined;
  }

  /** Whether `HEAD` is an ancestor of the branch, so a fast-forward to it is possible. Throws when Git cannot tell. */
  async headIsAncestorOf(workspacePath: string, branch: string): Promise<boolean> {
    try {
      await this.runGit(workspacePath, ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${branch}`], gitReadEnv());
      return true;
    } catch (error) {
      if (gitExitCode(error) === 1) return false;
      throw error;
    }
  }

  // `-d`, never `-D`: Git refuses a branch that HEAD does not contain, and one
  // any worktree still has checked out.
  async deleteMergedBranch(workspacePath: string, branch: string): Promise<void> {
    await this.runGit(workspacePath, ["branch", "-d", "--", branch], gitCommandEnv());
  }

  async mergeFastForward(workspacePath: string, branch: string): Promise<void> {
    await this.runGit(workspacePath, ["merge", "--ff-only", "--", branch], gitCommandEnv());
  }

  // A merge commit, never a conflicted tree: the abort puts the branch, index
  // and files back as they were. Any failure can leave a merge in progress, a
  // conflict or a merge hook's refusal (both exit 1), so every failure aborts
  // one Git recorded. Only a conflict leaves unmerged paths, and it returns
  // `aborted`; any other failure stands once aborted. A failure with no merge
  // recorded leaves nothing to abort. `abort_failed` means the merge is still
  // in progress.
  async mergeOrAbort(workspacePath: string, branch: string): Promise<"merged" | "aborted" | "abort_failed"> {
    try {
      await this.runGit(workspacePath, ["merge", "--no-ff", "--no-edit", "--", branch], gitCommandEnv());
      return "merged";
    } catch (error) {
      if ((await this.tryGit(workspacePath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) === undefined) throw error;
      const conflicted = Boolean((await this.tryGit(workspacePath, ["ls-files", "--unmerged"]))?.trim());
      try {
        await this.runGit(workspacePath, ["merge", "--abort"], gitCommandEnv());
      } catch {
        return "abort_failed";
      }
      if (!conflicted) throw error;
      return "aborted";
    }
  }

  async fetch(workspacePath: string, remote: string | undefined): Promise<void> {
    // `--prune` drops remote-tracking refs whose upstream branch is gone, so the
    // ahead/behind counts the client renders do not stay pinned to a dead branch.
    const argv = remote ? ["fetch", "--prune", "--", remote] : ["fetch", "--prune"];
    await this.runGitNetwork(workspacePath, argv, gitNetworkEnv());
  }

  // Fast-forward only, by design: a diverged branch fails with git's own message
  // instead of producing a merge commit or a conflicted worktree that a client
  // with no conflict-resolution surface cannot finish.
  async pullFastForward(workspacePath: string): Promise<void> {
    await this.runGitNetwork(workspacePath, ["pull", "--ff-only"], gitNetworkEnv());
  }

  // Never force: no `--force`, no `--force-with-lease`, and no caller-supplied
  // refspec. A rejected non-fast-forward push surfaces git's error.
  //
  // With an upstream already configured, this is a bare `git push`, so git's own
  // `push.default` decides the destination exactly as it would in a terminal. A
  // target is passed only to publish a branch that has no upstream yet.
  async push(workspacePath: string, target: GitPushTarget | undefined): Promise<void> {
    const argv = target ? ["push", "--set-upstream", "--", target.remote, target.branch] : ["push"];
    await this.runGitNetwork(workspacePath, argv, gitNetworkEnv());
  }

  async remotes(workspacePath: string): Promise<string[]> {
    return parseRemoteNames(await this.tryGit(workspacePath, ["remote"]));
  }

  /** The remote a branch is configured to push to, when it has one. */
  async branchRemote(workspacePath: string, branch: string): Promise<string | undefined> {
    return optionalGitValue(await this.tryGit(workspacePath, ["config", "--get", `branch.${branch}.remote`]));
  }

  private async runPathspecBatches(workspacePath: string, argv: string[], relPaths: string[]): Promise<void> {
    for (let index = 0; index < relPaths.length; index += maxPathspecsPerInvocation) {
      const batch = relPaths.slice(index, index + maxPathspecsPerInvocation);
      if (batch.length === 0) continue;
      await this.runGit(workspacePath, [...argv, ...batch.map(literalPathspec)], gitCommandEnv());
    }
  }

  async status(workspaceId: string, workspacePath: string): Promise<LocalWorkspaceGitStatus> {
    try {
      if (!(await this.isInsideWorkTree(workspacePath))) return cleanNonRepositoryStatus(workspaceId);

      const branch = optionalGitValue(await this.tryGit(workspacePath, ["branch", "--show-current"]));
      const entries = await this.changedEntries(workspacePath);
      // Plumbing `diff-files`: porcelain `git diff` rewrites the index under
      // `index.lock` (see `gitReadEnv`). `--cached` compares no working tree
      // and writes nothing.
      const unstagedNumstat = await this.tryGit(workspacePath, ["diff-files", "--numstat", "-z", "--relative"]) ?? "";
      const stagedNumstat = await this.tryGit(workspacePath, ["diff", "--cached", "--numstat", "-z", "--relative"]) ?? "";
      const allFiles = gitStatusFiles(entries, unstagedNumstat, stagedNumstat);
      const files = allFiles.slice(0, maxGitStatusFiles);

      return {
        workspaceId,
        isRepository: true,
        ...(branch ? { branch } : {}),
        clean: allFiles.length === 0,
        counts: gitStatusCounts(allFiles),
        files,
        truncated: allFiles.length > maxGitStatusFiles,
        refreshedAt: new Date().toISOString()
      };
    } catch {
      return cleanNonRepositoryStatus(workspaceId);
    }
  }

  async fileAtHead(workspacePath: string, relPath: string, maxBytes: number): Promise<GitFileAtHeadResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) return { isRepository: false, existsInHead: false };
    return readGitFileAtHead(
      (args) => this.tryGit(workspacePath, args),
      (args) => this.runGitBlob(workspacePath, args, gitReadEnv()),
      relPath,
      maxBytes
    );
  }

  // Fixed, shell-free enumeration of the paths a workspace's Git repository
  // considers "the project": tracked files plus untracked ones that are not
  // ignored. `--exclude-standard` is what gives the file index and the content
  // search `.gitignore` respect for free, and `-z` keeps paths raw (git's
  // default output quotes non-ASCII names). Run with the registered workspace as
  // cwd, `ls-files` reports paths relative to that directory and lists nothing
  // above it, so a workspace registered inside a larger repository stays bounded
  // to its own subtree. The result is unfiltered on purpose: secret-name,
  // generated-directory, and symlink-containment filtering belong to the caller
  // (WorkspaceExplorer), which applies exactly the tree read's rules.
  async listFiles(workspacePath: string, maxPaths: number): Promise<GitListFilesResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) return { isRepository: false, paths: [], truncated: false };
    const output = await this.tryGit(workspacePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (output === undefined) return { isRepository: false, paths: [], truncated: false };

    const tokens = output.split("\0").filter((token) => token.length > 0);
    // A conflicted path appears once per merge stage in `--cached`, so dedupe.
    const paths = new Set<string>();
    let index = 0;
    for (; index < tokens.length && paths.size < maxPaths; index += 1) {
      paths.add(tokens[index]);
    }
    return { isRepository: true, paths: [...paths], truncated: index < tokens.length };
  }

  private async isInsideWorkTree(workspacePath: string): Promise<boolean> {
    const inside = (await this.tryGit(workspacePath, ["rev-parse", "--is-inside-work-tree"]))?.trim();
    return inside === "true";
  }

  private async tryGit(workspacePath: string, args: string[]): Promise<string | undefined> {
    try {
      return (await this.runGit(workspacePath, args, gitReadEnv())).stdout;
    } catch {
      return undefined;
    }
  }
}

function assertFullCommitId(commit: string): void {
  if (!fullCommitIdPattern.test(commit)) throw new Error("Expected a full commit id");
}
