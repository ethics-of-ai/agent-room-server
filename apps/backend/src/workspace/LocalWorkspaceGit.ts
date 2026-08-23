import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "../util/redactSecrets";
import type {
  LocalWorkspaceGitBranch,
  LocalWorkspaceGitChangedFile,
  LocalWorkspaceGitFileStatus,
  LocalWorkspaceGitStatus,
  LocalWorkspaceGitSnapshot
} from "../domain/models";

const execFileAsync = promisify(execFile);
const maxGitStatusFiles = 200;
// `execFile` defaults to a 1 MB stdout buffer and fails the whole command with
// ENOBUFS past it. A large repository's `ls-files` (and a very dirty tree's
// `status --porcelain`) exceed that, so raise the ceiling once here; every
// consumer still caps how much of the output it retains.
const maxGitOutputBytes = 16 * 1024 * 1024;
const conflictStatusCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
// The git tree-entry file mode for a symlink. `git cat-file -t` reports "blob"
// for a symlink's target exactly as for a regular file (that distinction lives
// in the tree entry's mode, not on the blob object), so a symlink is only
// detectable by reading its mode via `ls-tree`.
const symlinkMode = "120000";

// Upper bound on how many pathspecs go into one `git` invocation. A very dirty
// tree can hold more changed paths than an argv can carry, so path-taking
// operations run in chunks instead of failing with E2BIG.
const maxPathspecsPerInvocation = 200;
/** Upper bound the commit route enforces on an incoming message. */
export const maxCommitMessageChars = 5000;

export type GitCommandExecutor = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<{ stdout: string; stderr: string }>;

// A second, narrower executor used only for reading blob content as raw bytes.
// Keeping this separate from `GitCommandExecutor` (which always decodes stdout
// as a utf8 string) lets `fileAtHead` detect invalid-UTF-8/binary content from
// the actual bytes instead of from an already-lossily-decoded string.
export type GitBlobExecutor = (cwd: string, args: string[]) => Promise<Buffer>;

export interface GitFileAtHeadResult {
  isRepository: boolean;
  existsInHead: boolean;
  objectKind?: "blob" | "other";
  sizeBytes?: number;
  content?: string;
  truncated?: boolean;
  /** The blob exists and is in range, but its bytes are not valid UTF-8 text. */
  binary?: boolean;
}

export interface GitListFilesResult {
  /** False for a non-repository workspace (or when git is unavailable); callers fall back to a filesystem walk. */
  isRepository: boolean;
  /** Repository-tracked and untracked-but-not-ignored paths, relative to the registered workspace directory. */
  paths: string[];
  /** True when the enumeration hit `maxPaths` and more paths existed. */
  truncated: boolean;
}

/**
 * One entry of the raw, uncapped porcelain status. The `status` route's
 * `LocalWorkspaceGitChangedFile` is the client-facing projection of this; the
 * mutating operations need the raw index/worktree status letters instead,
 * because "is this path in HEAD" is what decides whether discarding it means
 * restoring it or deleting it.
 */
export interface GitChangedEntry {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
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
      const branch = optionalGitValue(await this.tryGit(workspacePath, ["branch", "--show-current"]));
      const remotes = await this.remotes(workspacePath);
      const remote = optionalGitValue(await this.tryGit(workspacePath, ["remote", "get-url", "origin"]));
      const branches = await this.branches(workspacePath, branch);
      const hasUncommittedChanges = await this.hasUncommittedChanges(workspacePath);
      // The current branch's tracking state is already in the branch list (one
      // `for-each-ref` supplies it for every branch), so surfacing it at the top
      // level costs no extra subprocess.
      const current = branches.find((candidate) => candidate.current);
      return {
        isRepository: true,
        ...(branch ? { branch } : {}),
        ...(remote ? { remote } : {}),
        hasRemote: remotes.length > 0,
        ...(current?.upstream ? { upstream: current.upstream } : {}),
        ...(current?.upstreamGone ? { upstreamGone: true } : {}),
        ...(current?.ahead !== undefined ? { ahead: current.ahead } : {}),
        ...(current?.behind !== undefined ? { behind: current.behind } : {}),
        branches,
        hasUncommittedChanges
      };
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
  // both runners.
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
    const output = await this.tryGit(workspacePath, ["remote"]);
    return (output ?? "")
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean);
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

    // Resolve HEAD to a fixed commit SHA once and read everything below against
    // that pinned commit (instead of the literal, moving ref `HEAD`), so a
    // concurrent branch switch or commit cannot make the type/mode/size/content
    // checks below observe different commits.
    const commit = (await this.tryGit(workspacePath, ["rev-parse", "HEAD"]))?.trim();
    // Any failure here (unborn HEAD) reads as "no baseline".
    if (!commit) return { isRepository: true, existsInHead: false };

    // `<commit>:./<path>` resolves the pathspec relative to the working directory
    // (the registered workspace), not the repository root, so a workspace
    // registered inside a larger repository stays bounded to its own subtree. The
    // path is already lexically bounded (no `..`, no absolute segments) by the caller.
    const spec = `${commit}:./${relPath}`;
    const objectType = (await this.tryGit(workspacePath, ["cat-file", "-t", spec]))?.trim();
    // Any failure here (path not tracked at this commit) reads as "no baseline".
    if (!objectType) return { isRepository: true, existsInHead: false };
    if (objectType !== "blob") return { isRepository: true, existsInHead: true, objectKind: "other" };

    // A "blob" object type alone doesn't say whether the tree entry pointing to
    // it is a symlink -- git records that as the entry's file mode, not on the
    // blob itself, so a committed symlink and a committed regular file report the
    // identical object type here. Read the tree entry's mode and refuse a symlink
    // instead of surfacing its raw target-path text as if it were the file's real
    // committed content.
    const mode = await this.blobModeAt(workspacePath, commit, relPath);
    if (mode === symlinkMode) return { isRepository: true, existsInHead: true, objectKind: "other" };

    const sizeOutput = (await this.tryGit(workspacePath, ["cat-file", "-s", spec]))?.trim();
    const sizeBytes = sizeOutput ? Number.parseInt(sizeOutput, 10) : Number.NaN;
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return { isRepository: true, existsInHead: false };
    if (sizeBytes > maxBytes) {
      // A baseline is only useful whole (a partial baseline would diff wrongly), so
      // an over-cap blob returns metadata without content instead of streaming an
      // unbounded buffer through the executor.
      return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, truncated: true };
    }

    let raw: Buffer;
    try {
      raw = await this.runGitBlob(workspacePath, ["cat-file", "blob", spec]);
    } catch {
      return { isRepository: true, existsInHead: false };
    }
    // Reject an embedded NUL (a valid but non-previewable UTF-8 code point, so the
    // round-trip check below wouldn't catch it) and reject content that doesn't
    // round-trip through UTF-8 unchanged (catches any invalid byte sequence, e.g.
    // Latin-1 text, which `Buffer#toString("utf8")` would otherwise silently
    // replace with U+FFFD instead of surfacing as the binary content it actually
    // is). Checking the raw bytes -- not the already-decoded string -- is what
    // makes the round-trip check catch invalid sequences a NUL-only check would miss.
    const content = raw.toString("utf8");
    if (raw.includes(0) || Buffer.compare(Buffer.from(content, "utf8"), raw) !== 0) {
      return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, binary: true };
    }
    return { isRepository: true, existsInHead: true, objectKind: "blob", sizeBytes, content, truncated: false };
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

  private async blobModeAt(workspacePath: string, commit: string, relPath: string): Promise<string | undefined> {
    const output = await this.tryGit(workspacePath, ["ls-tree", "-z", commit, "--", `./${relPath}`]);
    const entry = output?.split("\0").find((line) => line.length > 0);
    return entry?.split(" ")[0];
  }

  // One `for-each-ref` supplies every local branch plus its upstream and
  // ahead/behind counts, so the tracking state the client's sync controls need
  // costs no subprocess beyond the branch list this already ran. The counts come
  // from the remote-tracking ref, so they reflect the last fetch — which is
  // exactly the semantics a "Fetch" button exists to refresh.
  private async branches(workspacePath: string, currentBranch: string | undefined): Promise<LocalWorkspaceGitBranch[]> {
    const output = await this.tryGit(workspacePath, [
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
      "refs/heads"
    ]);
    return (output ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [name = "", upstream = "", track = ""] = line.split("\t");
        return { name: name.trim(), upstream: upstream.trim(), track: track.trim() };
      })
      .filter((entry) => entry.name.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        name: entry.name,
        current: entry.name === currentBranch,
        ...(entry.upstream ? { upstream: entry.upstream } : {}),
        ...parseUpstreamTrack(entry.track, Boolean(entry.upstream))
      }));
  }

  private async hasUncommittedChanges(workspacePath: string): Promise<boolean> {
    const status = await this.tryGit(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]);
    return Boolean(status?.trim());
  }

  private async tryGit(workspacePath: string, args: string[]): Promise<string | undefined> {
    try {
      return (await this.runGit(workspacePath, args)).stdout;
    } catch {
      return undefined;
    }
  }
}

export function defaultGitExecutor(timeoutMs: number): GitCommandExecutor {
  return async (cwd, args, env) => {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      timeout: timeoutMs,
      maxBuffer: maxGitOutputBytes,
      windowsHide: true
    });
    return { stdout, stderr };
  };
}

// A raw-`Buffer` counterpart to `defaultGitExecutor`, used only for reading blob
// content. Implemented with the callback form of `execFile` (rather than
// `promisify`) so the `encoding: "buffer"` option is unambiguous: `execFile`'s
// overloads pick the string-returning signature when accessed through a single
// pre-bound `promisify`d function, which is why `defaultGitExecutor` cannot also
// serve buffer reads.
export function defaultGitBlobExecutor(timeoutMs: number): GitBlobExecutor {
  return (cwd, args) =>
    new Promise<Buffer>((resolveBuffer, reject) => {
      execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: "buffer" }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveBuffer(stdout);
      });
    });
}

// A git failure's stderr is git's text, not AgentRoom's, and it reaches HTTP
// responses, events, and durable audit. A remote error in particular can echo the
// remote URL, and an HTTPS remote can carry credentials in its userinfo
// (`https://user:token@host/repo`), so strip userinfo first and then apply the
// shared labelled-secret redaction.
export function gitErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const failure = error as { stderr?: unknown; stdout?: unknown };
    // Not every git failure explains itself on stderr: `commit` with nothing
    // staged, for one, prints "nothing to commit" to stdout and exits non-zero,
    // so falling back to stdout is what makes those diagnosable.
    const detail = String(failure.stderr ?? "").trim() || String(failure.stdout ?? "").trim();
    if (detail) return redactSecrets(redactUrlCredentials(detail)).slice(0, 500);
  }
  return fallback;
}

const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

function redactUrlCredentials(value: string): string {
  return value.replace(URL_USERINFO_PATTERN, "$1[REDACTED]@");
}

function optionalGitValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function literalPathspec(relPath: string): string {
  // `:(literal)` disables every pathspec magic, so a path that happens to begin
  // with `:` or contain a glob character is matched as the literal path it is.
  return `:(literal)${relPath}`;
}

function gitCommandEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0"
  };
}

// Remote operations must never block on an interactive prompt: the backend is a
// sidecar with no controlling terminal, so a prompt would hang the request until
// the network timeout. `GIT_TERMINAL_PROMPT=0` makes git fail instead of asking,
// and SSH runs in batch mode so a passphrase-locked key that is not in the agent
// fails immediately. Both respect an operator-set value. Credential helpers (the
// macOS keychain helper in particular) are deliberately left intact — they are
// what makes an HTTPS push work without a prompt.
function gitNetworkEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? "never"
  };
}

// `%(upstream:track)` is empty for a branch with no upstream AND for one exactly
// in sync, so "has an upstream" is what separates "unknown" from "0 ahead, 0
// behind". `[gone]` means the upstream ref no longer exists.
function parseUpstreamTrack(track: string, hasUpstream: boolean): Pick<LocalWorkspaceGitBranch, "ahead" | "behind" | "upstreamGone"> {
  if (!hasUpstream) return {};
  if (track.includes("gone")) return { upstreamGone: true };
  const ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? "0", 10);
  const behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? "0", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  };
}

type ParsedPorcelainFile = GitChangedEntry;

interface ParsedNumstatFile {
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

function gitStatusFiles(
  entries: GitChangedEntry[],
  unstagedNumstat: string,
  stagedNumstat: string
): LocalWorkspaceGitChangedFile[] {
  const files = new Map<string, LocalWorkspaceGitChangedFile>();

  for (const item of entries) {
    files.set(item.path, {
      path: item.path,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      status: statusFromCodes(item.indexStatus, item.worktreeStatus),
      staged: isStagedStatus(item.indexStatus),
      unstaged: isUnstagedStatus(item.worktreeStatus),
      ...lineCountsFor(undefined, undefined)
    });
  }

  for (const item of parseNumstat(unstagedNumstat)) {
    mergeNumstat(files, item, "unstaged");
  }
  for (const item of parseNumstat(stagedNumstat)) {
    mergeNumstat(files, item, "staged");
  }

  return [...files.values()]
    .map((file) => stripUndefinedCounts(file))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function workspaceRelativeGitPath(repositoryPath: string, prefix: string): string | undefined {
  if (!prefix) return repositoryPath || undefined;
  if (!repositoryPath.startsWith(prefix)) return undefined;
  return repositoryPath.slice(prefix.length) || undefined;
}

function stripTrailingLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function parsePorcelainStatus(output: string): ParsedPorcelainFile[] {
  const tokens = output.split("\0");
  const files: ParsedPorcelainFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4) continue;

    const indexStatus = token[0] ?? " ";
    const worktreeStatus = token[1] ?? " ";
    const path = token.slice(3);
    if (!path) continue;

    let oldPath: string | undefined;
    if (isRenameOrCopyStatus(indexStatus) || isRenameOrCopyStatus(worktreeStatus)) {
      oldPath = tokens[index + 1] || undefined;
      index += oldPath ? 1 : 0;
    }

    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      indexStatus,
      worktreeStatus
    });
  }
  return files;
}

function parseNumstat(output: string): ParsedNumstatFile[] {
  const tokens = output.split("\0");
  const files: ParsedNumstatFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const additions = parseNumstatCount(parts[0]);
    const deletions = parseNumstatCount(parts[1]);
    let path = parts.slice(2).join("\t");
    let oldPath: string | undefined;

    if (!path) {
      oldPath = tokens[index + 1] || undefined;
      path = tokens[index + 2] || "";
      index += path ? 2 : 0;
    }

    if (!path) continue;
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      ...lineCountsFor(additions, deletions)
    });
  }
  return files;
}

function mergeNumstat(
  files: Map<string, LocalWorkspaceGitChangedFile>,
  item: ParsedNumstatFile,
  scope: "staged" | "unstaged"
): void {
  const existing = files.get(item.path) ?? {
    path: item.path,
    status: item.oldPath ? "renamed" : "modified",
    staged: false,
    unstaged: false
  } satisfies LocalWorkspaceGitChangedFile;

  files.set(item.path, stripUndefinedCounts({
    ...existing,
    ...(item.oldPath && !existing.oldPath ? { oldPath: item.oldPath } : {}),
    staged: existing.staged || scope === "staged",
    unstaged: existing.unstaged || scope === "unstaged",
    additions: sumOptional(existing.additions, item.additions),
    deletions: sumOptional(existing.deletions, item.deletions)
  }));
}

function gitStatusCounts(files: LocalWorkspaceGitChangedFile[]) {
  return {
    total: files.length,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged && file.status !== "untracked").length,
    untracked: files.filter((file) => file.status === "untracked").length,
    conflicts: files.filter((file) => file.status === "conflicted").length
  };
}

function statusFromCodes(indexStatus: string, worktreeStatus: string): LocalWorkspaceGitFileStatus {
  if (conflictStatusCodes.has(`${indexStatus}${worktreeStatus}`)) return "conflicted";
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (isRenameOrCopyStatus(indexStatus) || isRenameOrCopyStatus(worktreeStatus)) {
    return indexStatus === "C" || worktreeStatus === "C" ? "copied" : "renamed";
  }
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "T" || worktreeStatus === "T") return "type_changed";
  return "modified";
}

function isStagedStatus(status: string): boolean {
  return status !== " " && status !== "?" && status !== "!";
}

// Entry-level porcelain predicates. Exported so the mutating operations classify
// a changed path by exactly the same status-letter rules the read projection
// uses, instead of re-deriving them and drifting.
export function isStagedEntry(entry: GitChangedEntry): boolean {
  return isStagedStatus(entry.indexStatus);
}

export function isUntrackedEntry(entry: GitChangedEntry): boolean {
  return entry.indexStatus === "?" && entry.worktreeStatus === "?";
}

export function isRenamedEntry(entry: GitChangedEntry): boolean {
  return isRenameOrCopyStatus(entry.indexStatus) || isRenameOrCopyStatus(entry.worktreeStatus);
}

function isUnstagedStatus(status: string): boolean {
  return status !== " " && status !== "!";
}

function isRenameOrCopyStatus(status: string): boolean {
  return status === "R" || status === "C";
}

function parseNumstatCount(value: string | undefined): number | undefined {
  if (!value || value === "-") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function lineCountsFor(additions: number | undefined, deletions: number | undefined): Pick<LocalWorkspaceGitChangedFile, "additions" | "deletions"> {
  return {
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {})
  };
}

function stripUndefinedCounts(file: LocalWorkspaceGitChangedFile): LocalWorkspaceGitChangedFile {
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    staged: file.staged,
    unstaged: file.unstaged,
    ...lineCountsFor(file.additions, file.deletions)
  };
}

function cleanNonRepositoryStatus(workspaceId: string): LocalWorkspaceGitStatus {
  return {
    workspaceId,
    isRepository: false,
    clean: true,
    counts: {
      total: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0
    },
    files: [],
    truncated: false,
    refreshedAt: new Date().toISOString()
  };
}
