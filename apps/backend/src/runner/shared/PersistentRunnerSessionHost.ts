import type { AgentRunnerKind } from "../../domain/models";
import { logger } from "../../logging/logger";

/**
 * How an adapter restores a conversation whose child process is gone — because
 * it died, was killed by an unresponsive cancel, or was idle-reaped.
 *
 * This is a capability, not a boolean, because the two working answers behave
 * differently for the host: `native_resume` continues the conversation without
 * replaying it (Codex `thread/resume`, Claude Agent SDK `resume`), while
 * `history_replay` rebuilds adapter state from a stream of past updates the
 * adapter must consume without duplicating AgentRoom's own transcript (ACP
 * `session/load`). `unsupported` is explicit rather than assumed: a runner that
 * cannot be restored is never idle-reaped, because reaping it would silently
 * start a fresh conversation under the same AgentRoom session id.
 */
export type RunnerRestoreStrategy = "native_resume" | "history_replay" | "unsupported";

/** The one field the host requires of an adapter's session record. */
export interface PersistentRunnerSession {
  readonly key: string;
}

export interface PersistentRunnerSessionHostOptions<S extends PersistentRunnerSession> {
  runnerKind: AgentRunnerKind;
  restoreStrategy: RunnerRestoreStrategy;
  idleSessionTimeoutMs: number;
  /**
   * Release the adapter's own resources for this session: kill the child,
   * dispose the protocol client, close the input queue. The host has already
   * dropped the session from its registry when this runs.
   *
   * Must be idempotent: a session displaced by a replacement is torn down at
   * displacement, and a caller still holding that reference may destroy it
   * again afterwards.
   */
  teardown(session: S): void;
  /**
   * Whether a turn is in flight. A busy session is never idle-reaped, however
   * long the turn runs.
   */
  isBusy(session: S): boolean;
  /**
   * Whether a registered session still has a live child worth reusing. Defaults
   * to true for adapters whose dead sessions remove themselves.
   */
  isReusable?(session: S): boolean;
  /** Bounded, non-secret fields for the idle-reap log line. */
  describe?(session: S): Record<string, string | number | undefined>;
}

interface HostedSession<S extends PersistentRunnerSession> {
  session: S;
  lastActivityAtMs: number;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The persistent-child lifecycle every session-holding runner needs: one live
 * child per AgentRoom session, idle reaping so N open threads do not pin N
 * resident processes, and the native id that lets the next turn resume a
 * conversation whose child is gone.
 *
 * Extracted from `CodexAppServerRunner` and `ClaudeCodeRunner`, which had
 * arrived at the same shape independently. Keeping it in one place is what
 * makes the reap-and-resume semantics documented in
 * `docs/safety/TRUST_AND_SAFETY.md` a single implementation rather than a
 * convention two adapters happen to follow — and it is what a third adapter
 * inherits instead of reimplementing.
 *
 * The host owns registry membership, activity timestamps, idle timers, and
 * resumable ids. It owns no protocol: spawning, handshaking, restoring, and
 * tearing down stay with the adapter, which is the boundary that keeps a
 * runner's native detail reachable.
 */
export class PersistentRunnerSessionHost<S extends PersistentRunnerSession> {
  private readonly entries = new Map<string, HostedSession<S>>();
  /**
   * Native thread/session ids that outlive their child process. Entries are
   * dropped only when the AgentRoom session is deleted, so an explicitly
   * deleted thread is never silently resumed.
   */
  private readonly resumableIds = new Map<string, string>();

  constructor(private readonly options: PersistentRunnerSessionHostOptions<S>) {}

  get restoreStrategy(): RunnerRestoreStrategy {
    return this.options.restoreStrategy;
  }

  /** True when a reaped or crashed child can be restored on the next turn. */
  get restorable(): boolean {
    return this.options.restoreStrategy !== "unsupported";
  }

  /**
   * The live session for this key, if one is still worth reusing. A registered
   * but no-longer-reusable session is dropped from the registry (without
   * teardown — its child is already gone) so the caller can spawn a fresh one.
   */
  acquire(key: string): S | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.options.isReusable && !this.options.isReusable(entry.session)) {
      this.releaseEntry(key, entry);
      return undefined;
    }
    entry.lastActivityAtMs = Date.now();
    return entry.session;
  }

  /**
   * Register a freshly spawned session and start its idle clock.
   *
   * Registering over a session that is still registered means an adapter raced
   * its own acquire-then-spawn path. The newest registration wins — it is the
   * one the caller is about to drive a turn on — but the loser is torn down
   * rather than left running with nothing holding a reference to it. Dropping
   * it silently is what would leak a child process, so the displacement is also
   * logged: it is an adapter bug, not a normal path.
   */
  register(session: S): void {
    const displaced = this.entries.get(session.key);
    if (displaced) {
      this.releaseEntry(session.key, displaced);
      logger.warn({
        runnerKind: this.options.runnerKind,
        sessionKey: session.key
      }, "Runner session replaced while still registered; tearing down the displaced child");
      this.options.teardown(displaced.session);
    }
    const entry: HostedSession<S> = { session, lastActivityAtMs: Date.now() };
    this.entries.set(session.key, entry);
    // A runner that cannot be restored is never reaped: killing its child would
    // lose the conversation with no way back.
    if (this.restorable) this.armIdleTimer(entry);
  }

  /** Mark activity so a working session is not reaped out from under a turn. */
  touch(session: S): void {
    const entry = this.entries.get(session.key);
    if (entry?.session !== session) return;
    entry.lastActivityAtMs = Date.now();
  }

  /**
   * Drop a session from the registry without tearing it down — for the paths
   * where the child is already gone (process `close`/`error`, a stream that
   * ended) and only the registry entry and its timer need clearing.
   */
  release(session: S): void {
    const entry = this.entries.get(session.key);
    if (entry?.session !== session) return;
    this.releaseEntry(session.key, entry);
  }

  /** Drop a session from the registry and release the adapter's resources. */
  destroy(session: S): void {
    const entry = this.entries.get(session.key);
    if (entry?.session === session) this.releaseEntry(session.key, entry);
    this.options.teardown(session);
  }

  /**
   * The AgentRoom session was deleted: forget how to resume it and release its
   * child. Forgetting comes first — an explicitly deleted thread must never be
   * silently resumed by a later session that reuses the id.
   */
  close(key: string): void {
    this.resumableIds.delete(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.destroy(entry.session);
  }

  /** Backend shutdown: tear every session down and forget everything. */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.options.teardown(entry.session);
    }
    this.entries.clear();
    this.resumableIds.clear();
  }

  /** The native id to restore this AgentRoom session's conversation with. */
  resumableId(key: string): string | undefined {
    return this.resumableIds.get(key);
  }

  /**
   * Record the native id a restore would use. Ignored for an `unsupported`
   * strategy, so the host can never hold a resume token it would not honor.
   */
  rememberResumableId(key: string, id: string): void {
    if (!this.restorable) return;
    this.resumableIds.set(key, id);
  }

  /** Forget a rejected id (a thread with no rollout, an externally pruned one). */
  forgetResumableId(key: string): void {
    this.resumableIds.delete(key);
  }

  private releaseEntry(key: string, entry: HostedSession<S>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }

  /**
   * Idle reaping mirrors the terminal service: a deadline check re-armed with
   * the remaining time, so activity touches stay O(1) writes rather than timer
   * churn. A reaped session's resumable id is kept, and the next turn restores
   * the conversation in a fresh child.
   */
  private armIdleTimer(entry: HostedSession<S>, delayMs = this.options.idleSessionTimeoutMs): void {
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(entry.session.key) !== entry) return;
      const idleForMs = Date.now() - entry.lastActivityAtMs;
      const busy = this.options.isBusy(entry.session);
      if (busy || idleForMs < this.options.idleSessionTimeoutMs) {
        this.armIdleTimer(entry, busy ? this.options.idleSessionTimeoutMs : this.options.idleSessionTimeoutMs - idleForMs);
        return;
      }
      logger.info({
        runnerKind: this.options.runnerKind,
        sessionKey: entry.session.key,
        ...this.options.describe?.(entry.session),
        idleForMs
      }, "Runner session idle-reaped");
      this.destroy(entry.session);
    }, delayMs);
    // Do not keep the event loop alive solely for an idle runner child.
    entry.idleTimer.unref?.();
  }
}
