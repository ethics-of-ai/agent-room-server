/**
 * Exit when the process that launched this backend goes away.
 *
 * The macOS app supervises the sidecar as a child process and SIGINTs it from
 * `applicationWillTerminate`. That path does not run when the app is force
 * quit, crashes, or is stopped from Xcode. The child is then reparented to
 * launchd, keeps holding the port, and the next app launch finds a healthy
 * backend it did not start and cannot stop.
 *
 * The one observation available to a child whose parent is gone is its own
 * parent pid changing, so that is what this checks immediately and then polls.
 * The launcher supplies its pid separately so an app that dies before this
 * module starts can still be recognised after the child has been reparented.
 *
 * It is off unless the launcher asks for it. A backend an operator started
 * themselves (`pnpm dev`, `pnpm start`, a disowned shell) has no parent whose
 * death should end it, so the macOS app opts in through
 * `AGENTROOM_EXIT_WITH_PARENT` and nothing else does.
 */
export interface ParentExitWatchdogOptions {
  /** The expected launcher pid. Reparenting is measured against it. */
  readonly parentPid: number;
  readonly intervalMs?: number;
  /** Injected for tests; defaults to this process's live parent pid. */
  readonly readParentPid?: () => number;
  /** Called once, when the parent pid no longer matches. */
  readonly onOrphaned: () => void;
}

export const DEFAULT_PARENT_EXIT_POLL_MS = 2_000;

/**
 * Arms the watchdog and returns a stop function. Returns `undefined` when the
 * launcher did not supply a usable pid. A mismatch is checked before the timer
 * is installed so launcher death during backend startup cannot escape the
 * watchdog.
 */
export function startParentExitWatchdog(
  options: ParentExitWatchdogOptions
): (() => void) | undefined {
  const { parentPid, onOrphaned } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_PARENT_EXIT_POLL_MS;
  const readParentPid = options.readParentPid ?? (() => process.ppid);

  if (!Number.isInteger(parentPid) || parentPid <= 1) {
    return undefined;
  }

  let fired = false;
  if (readParentPid() !== parentPid) {
    fired = true;
    onOrphaned();
    return () => {};
  }

  const timer = setInterval(() => {
    if (fired) return;
    if (readParentPid() === parentPid) return;
    fired = true;
    clearInterval(timer);
    onOrphaned();
  }, intervalMs);

  // Never keep the process alive on the watchdog's account: the server's own
  // handles decide how long the backend runs, and a timer that outlived them
  // would turn a clean shutdown into a two-second hang.
  timer.unref?.();

  return () => {
    fired = true;
    clearInterval(timer);
  };
}
