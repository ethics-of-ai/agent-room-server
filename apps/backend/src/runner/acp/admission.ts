import { constants } from "node:fs";
import { accessSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Process admission for external ACP adapters (Phase 7 of
 * docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md).
 *
 * Running an operator-supplied binary that receives workspace paths and drives
 * turns is a **new trust surface**, not a variation on the existing runners: the
 * Codex and Claude Code executables are named by the same tier-3 mechanism, but
 * they are two known programs with documented postures, while this admits an
 * arbitrary one. Everything here exists so that "which binary runs" is a
 * decision the operator made on their own Mac, in the environment, and nowhere
 * else — never a managed setting, never a served descriptor, never a value that
 * crossed the wire. See docs/safety/TRUST_AND_SAFETY.md.
 */

export interface AdmissionFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface AdmissionSuccess {
  readonly ok: true;
  /** The canonicalized path actually spawned. */
  readonly executable: string;
}

export type AdmissionResult = AdmissionSuccess | AdmissionFailure;

/**
 * Whether this absolute path may be spawned.
 *
 * The rules, and why each one is here:
 *
 * - **Absolute only.** A relative path resolves against a working directory,
 *   which for a turn is a *registered workspace* — so a relative command would
 *   let a repository decide which binary runs.
 * - **Not a symlink.** The path is `lstat`ed before it is resolved, and a
 *   symlink is refused rather than followed. The operator allowlisted a
 *   particular program; a symlink is a level of indirection whose target can be
 *   repointed afterwards without the allowlist changing, which would turn a
 *   reviewed decision into a mutable one.
 * - **A regular file with an executable bit.** A directory, socket, or device
 *   named where a program is expected is a configuration mistake worth
 *   reporting, not something to hand to `spawn` and discover as a confusing
 *   `EACCES` later.
 *
 * The realpath is returned and is what gets spawned, so the resolved target is
 * also what any diagnostic names.
 */
export function admitExecutable(path: string): AdmissionResult {
  if (!path || !isAbsolute(path)) {
    return { ok: false, reason: "executable path must be absolute" };
  }
  let link;
  try {
    link = lstatSync(path);
  } catch {
    return { ok: false, reason: "executable does not exist" };
  }
  if (link.isSymbolicLink()) {
    return { ok: false, reason: "executable path is a symlink; name the program itself" };
  }
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return { ok: false, reason: "executable path could not be resolved" };
  }
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    return { ok: false, reason: "executable does not exist" };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "executable path is not a regular file" };
  }
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    return { ok: false, reason: "executable path is not executable" };
  }
  return { ok: true, executable: resolved };
}

/**
 * The environment names every adapter child gets, regardless of configuration.
 *
 * This is an **allowlist, not an inheritance**, which is the one place an
 * external adapter's posture is deliberately stricter than the built-in
 * runners'. Codex and Claude Code inherit the operator's environment minus
 * `AUTH_TOKEN` (and, for Claude Code, the provider credentials it scrubs),
 * because they need it to find their own credentials and tooling. An arbitrary
 * operator-supplied binary has no such claim: inheriting would hand every
 * unrelated developer credential in the backend's environment to a program
 * whose only qualification is that a path was allowlisted.
 *
 * The base is what a process needs to run at all and locate its own files.
 */
const BASE_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const;

/**
 * Names that may never be granted, whatever an adapter's configuration asks
 * for. `AUTH_TOKEN` is AgentRoom's own transport secret — it is not a provider
 * credential and no child the backend spawns has a use for it, which is the
 * same rule the Codex app-server, the Claude Code CLI, and the terminal PTY
 * already follow.
 */
const NEVER_GRANTED = new Set(["AUTH_TOKEN"]);

export function isGrantableEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && !NEVER_GRANTED.has(name);
}

/**
 * Build the child environment: the base allowlist plus the credential names the
 * operator explicitly granted this adapter, and nothing else.
 *
 * A granted name that is unset in the backend's own environment is simply
 * absent — a grant is permission to pass a value along, not a promise that one
 * exists.
 */
export function buildAcpChildEnv(
  grants: readonly string[],
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...grants]) {
    if (NEVER_GRANTED.has(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
