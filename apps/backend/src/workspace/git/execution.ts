import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "../../util/redactSecrets";

const execFileAsync = promisify(execFile);
// `execFile` defaults to a 1 MB stdout buffer and fails the whole command with
// ENOBUFS past it. A large repository's `ls-files` (and a very dirty tree's
// `status --porcelain`) exceed that, so raise the ceiling once here; every
// consumer still caps how much of the output it retains.
const maxGitOutputBytes = 16 * 1024 * 1024;

export type GitCommandExecutor = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<{ stdout: string; stderr: string }>;

// A second, narrower executor used only for reading blob content as raw bytes.
// Keeping this separate from `GitCommandExecutor` (which always decodes stdout
// as a utf8 string) lets `fileAtHead` detect invalid-UTF-8/binary content from
// the actual bytes instead of from an already-lossily-decoded string.
export type GitBlobExecutor = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<Buffer>;

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
  return (cwd, args, env) =>
    new Promise<Buffer>((resolveBuffer, reject) => {
      execFile("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined,
        timeout: timeoutMs, windowsHide: true, encoding: "buffer" }, (error, stdout) => {
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

/** Git's exit status for a command that ran and failed; undefined when it never ran or timed out. */
export function gitExitCode(error: unknown): number | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" ? code : undefined;
}

export function optionalGitValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function literalPathspec(relPath: string): string {
  // `:(literal)` disables every pathspec magic, so a path that happens to begin
  // with `:` or contain a glob character is matched as the literal path it is.
  return `:(literal)${relPath}`;
}

export function gitCommandEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0"
  };
}

// `git status` refreshes the index's cached file stats and writes them back
// when it can take `index.lock`. The write is optional, but while a read holds
// the lock, a commit or merge in the same checkout fails with "index.lock
// exists". A child summary reads its worktree the moment a turn settles, which
// is when the child or the person commits there. `GIT_OPTIONAL_LOCKS=0` skips
// the write and leaves the output unchanged, so every read-only command runs
// with it; mutations keep `gitCommandEnv()`. Porcelain `git diff` against the
// working tree writes the index regardless of this variable, so those reads
// use the plumbing `diff-files` and `diff-index`, which never write it.
export function gitReadEnv(): NodeJS.ProcessEnv {
  return { ...gitCommandEnv(), GIT_OPTIONAL_LOCKS: "0" };
}

// Remote operations must never block on an interactive prompt: the backend is a
// sidecar with no controlling terminal, so a prompt would hang the request until
// the network timeout. `GIT_TERMINAL_PROMPT=0` makes git fail instead of asking,
// and SSH runs in batch mode so a passphrase-locked key that is not in the agent
// fails immediately. Both respect an operator-set value. Credential helpers (the
// macOS keychain helper in particular) are deliberately left intact — they are
// what makes an HTTPS push work without a prompt.
export function gitNetworkEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? "never"
  };
}
