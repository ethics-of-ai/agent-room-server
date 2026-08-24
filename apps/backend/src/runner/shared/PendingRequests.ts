/**
 * The waiting half shared by every "ask the person driving the session"
 * channel: a per-session table of outstanding request ids, each holding a
 * promise open until something settles it — a human answer, the bounded clock,
 * or the release that comes with the turn, the child, or the session going
 * away.
 *
 * It knows nothing about what is being asked. `PendingPermissionRequests` puts
 * an agent's option vocabulary behind it; `PendingQuestionRequests` puts a batch
 * of clarifying questions behind it. Each owns its validation and its outcome
 * shape; this class owns only the id table, the clock, the per-session cap, and
 * the release paths, which is the part that must behave identically for both
 * and the part a second adapter must not reimplement.
 *
 * Three properties hold for every channel built on it:
 *
 * - **Registration is synchronous.** `open` has recorded the request before it
 *   returns, so a caller can publish the id without racing a fast answer.
 * - **Every wait ends.** The clock settles a forgotten request, and
 *   `releaseSession` settles everything a session still holds.
 * - **The table is bounded.** A session at its cap admits no further request,
 *   and a duplicate id is refused rather than replacing a live wait.
 */
export interface PendingRequestsOptions<TEntry, TOutcome> {
  timeoutMs: number;
  maxPerSession: number;
  /** The outcome a request receives when its clock runs out. */
  onTimeout: (entry: TEntry) => TOutcome;
  /** The outcome a request receives when its owner releases it unanswered. */
  onRelease: (entry: TEntry) => TOutcome;
}

interface WaitingRequest<TEntry, TOutcome> {
  readonly entry: TEntry;
  readonly timer: NodeJS.Timeout;
  settle(outcome: TOutcome): void;
}

export class PendingRequests<TEntry, TOutcome> {
  private readonly bySession = new Map<string, Map<string, WaitingRequest<TEntry, TOutcome>>>();

  constructor(private readonly options: PendingRequestsOptions<TEntry, TOutcome>) {}

  /**
   * Hold `requestId` open for this session. Returns `undefined` — and opens no
   * wait — when the session is at its cap or already holds that id; the caller
   * then falls back to its own policy and must not advertise the id as
   * answerable.
   */
  open(sessionKey: string, requestId: string, entry: TEntry): Promise<TOutcome> | undefined {
    const requests = this.bySession.get(sessionKey) ?? new Map<string, WaitingRequest<TEntry, TOutcome>>();
    if (requests.size >= this.options.maxPerSession) return undefined;
    if (requests.has(requestId)) return undefined;
    this.bySession.set(sessionKey, requests);

    return new Promise<TOutcome>((resolve) => {
      const settle = (outcome: TOutcome): void => {
        const pending = this.bySession.get(sessionKey);
        pending?.delete(requestId);
        if (pending?.size === 0) this.bySession.delete(sessionKey);
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle(this.options.onTimeout(entry)), this.options.timeoutMs);
      // Do not keep the event loop alive solely for a person who may not answer.
      timer.unref?.();
      requests.set(requestId, { entry, timer, settle });
    });
  }

  /** What the request is holding, for a channel's own answer validation. */
  entry(sessionKey: string, requestId: string): TEntry | undefined {
    return this.bySession.get(sessionKey)?.get(requestId)?.entry;
  }

  /** Settle an outstanding request; `false` when it is not outstanding. */
  settle(sessionKey: string, requestId: string, outcome: TOutcome): boolean {
    const request = this.bySession.get(sessionKey)?.get(requestId);
    if (!request) return false;
    request.settle(outcome);
    return true;
  }

  /** Release one request unanswered (a cancelled turn, an aborted call). */
  release(sessionKey: string, requestId: string): boolean {
    const request = this.bySession.get(sessionKey)?.get(requestId);
    if (!request) return false;
    request.settle(this.options.onRelease(request.entry));
    return true;
  }

  /** Settle everything this session holds, so no wait outlives it. */
  releaseSession(sessionKey: string): void {
    const requests = this.bySession.get(sessionKey);
    if (!requests) return;
    for (const request of [...requests.values()]) request.settle(this.options.onRelease(request.entry));
    this.bySession.delete(sessionKey);
  }

  releaseAll(): void {
    for (const sessionKey of [...this.bySession.keys()]) this.releaseSession(sessionKey);
  }

  /** Outstanding request count, for bounds assertions in tests. */
  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }
}
