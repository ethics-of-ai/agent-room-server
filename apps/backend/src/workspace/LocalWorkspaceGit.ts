import type { LocalWorkspaceGitStatus, LocalWorkspaceGitSnapshot } from "../domain/models";
import {
  gitCommandEnv,
  gitNetworkEnv,
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
// flag, a refspec, or a ref. See `docs/safety/TRUST_AND_SAFETY.md`
// (*Mutating Git operations*).

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
  constructor(
    private readonly runGit: GitCommandExecutor,
    private readonly runGitBlob: GitBlobExecutor,
    /**
     * Executor for the three operations that talk to a remote. Separate from
     * `runGit` only so those can carry a longer timeout than the local-command
     * one — a fetch over a slow link is not a hung command.
     */
    private readonly runGitNetwork: GitCommandExecutor = runGit
  ) {}

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
        gitCommandEnv()
      ),
      this.runGit(workspacePath, ["rev-parse", "--show-prefix"], gitCommandEnv())
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
        gitCommandEnv()
      ),
      this.runGit(workspacePath, ["rev-parse", "--show-prefix"], gitCommandEnv())
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
      const unstagedNumstat = await this.tryGit(workspacePath, ["diff", "--numstat", "-z", "--relative"]) ?? "";
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
      (args) => this.runGitBlob(workspacePath, args),
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
      return (await this.runGit(workspacePath, args)).stdout;
    } catch {
      return undefined;
    }
  }
}
