import { stat } from "node:fs/promises";

// Shared by the workspace tree watcher and the HEAD watcher: the slice of
// `fs.watch` they use, root identity, event routing, background-work tracking,
// and the burst schedule that bounds how often either one publishes.

/** The slice of `fs.FSWatcher` a watcher uses, so tests can drive events by hand. */
export interface DirectoryWatchHandle {
  close(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export type DirectoryWatchFunction = (
  directory: string,
  listener: (eventType: string, filename: string | null) => void
) => DirectoryWatchHandle;

/** A directory's device and inode, or undefined when it is gone or not a directory. */
export async function directoryIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** The `workspaceId` of a workspace event's payload, when it has one. */
export function workspaceIdOf(payload: unknown): string | undefined {
  const workspaceId = (payload as { workspaceId?: unknown } | undefined)?.workspaceId;
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

/**
 * Runs work that no caller awaits, reporting a failure instead of leaving it
 * unhandled, and lets close wait for whatever is still running.
 */
export class BackgroundWork {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly onError?: (error: unknown) => void) {}

  track(work: Promise<void>): void {
    const settled = work
      .catch((error: unknown) => this.onError?.(error))
      .finally(() => this.inFlight.delete(settled));
    this.inFlight.add(settled);
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

export interface BurstTiming {
  /** Quiet time that ends a burst. */
  debounceMs: number;
  /** Least time between two fires. */
  minIntervalMs: number;
  /** Longest a burst waits from its first event, so a steady stream still fires. */
  maxWaitMs: number;
}

/**
 * Collapses a burst of events into one fire. A burst fires after `debounceMs`
 * of quiet, never sooner than `minIntervalMs` after the last fire, and never
 * later than `maxWaitMs` after its first event, so a log written every few
 * hundred milliseconds still fires about once per `maxWaitMs`.
 */
export class BurstSchedule {
  private timer?: NodeJS.Timeout;
  private burstStartedAt?: number;
  private lastFiredAt = 0;

  constructor(
    private readonly timing: BurstTiming,
    private readonly fire: () => void
  ) {}

  schedule(): void {
    const now = Date.now();
    this.burstStartedAt ??= now;
    const earliest = this.lastFiredAt + this.timing.minIntervalMs;
    const quiet = Math.max(now + this.timing.debounceMs, earliest);
    const deadline = Math.max(this.burstStartedAt + this.timing.maxWaitMs, earliest);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.burstStartedAt = undefined;
      this.fire();
    }, Math.max(0, Math.min(quiet, deadline) - now));
    this.timer.unref?.();
  }

  /** Records a publish, which starts the minimum interval. */
  markFired(): void {
    this.lastFiredAt = Date.now();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.burstStartedAt = undefined;
  }
}

/**
 * Reports each workspace's watch failure once until a watch opens again, so a
 * root that fails on every reconcile pass logs one line, not one a minute.
 */
export class WatchFailureReporter {
  private readonly failing = new Set<string>();

  constructor(private readonly onError?: (error: unknown) => void) {}

  failed(key: string, error: unknown): void {
    if (this.failing.has(key)) return;
    this.failing.add(key);
    this.onError?.(error);
  }

  recovered(key: string): void {
    this.failing.delete(key);
  }

  clear(): void {
    this.failing.clear();
  }
}
