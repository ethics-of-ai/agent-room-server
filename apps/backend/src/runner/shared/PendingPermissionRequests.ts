/**
 * Outstanding permission requests waiting for a human answer.
 *
 * A runner that asks permission mid-turn has, until now, had exactly two
 * answers available to it: refuse everything, or the unattended allow. This is
 * the third — ask the person driving the session — and it is the *waiting* half
 * of it, kept here rather than in an adapter for the same reason
 * `PersistentRunnerSessionHost` is: an adapter owns its protocol, and a bounded
 * per-session wait is not protocol.
 *
 * Three properties make this safe to expose:
 *
 * - **The wait is bounded.** A turn that blocks forever on an absent operator is
 *   a worse failure than a refusal, so every wait carries a timeout after which
 *   the caller applies its configured policy and says so.
 * - **Only an option the agent offered can be chosen.** The answer is checked
 *   against the option ids that arrived with the request, so a client can
 *   neither invent an option nor answer a request the agent has not made.
 * - **Everything is in memory, per session, and released with it.** A session
 *   that goes away takes its outstanding requests with it, and the waits they
 *   hold settle rather than leak.
 */

/** Who decided a permission request. Reported on the resolved event and audited. */
export type PermissionDecisionAuthority = "human" | "policy" | "timeout";

/** One option the agent itself offered for a request. */
export interface PermissionRequestOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/**
 * Bounds shared by the runner boundary, the wire projection, and the answer
 * route. Option ids are opaque: they may be refused for exceeding a bound, but
 * must never be trimmed or truncated into a different id on the round trip.
 */
export const MAX_PERMISSION_OPTIONS = 16;
export const MAX_PERMISSION_REQUEST_ID_LENGTH = 200;
export const MAX_PERMISSION_OPTION_ID_LENGTH = 200;
export const MAX_PERMISSION_OPTION_NAME_LENGTH = 200;
export const MAX_PERMISSION_OPTION_KIND_LENGTH = 100;

export type PermissionWaitOutcome =
  | { decidedBy: "human"; optionId: string }
  /** The bounded wait ended without a human answer — the clock, or a release. */
  | { decidedBy: "timeout" };

export type PermissionAnswerResult = "answered" | "unknown_request" | "unknown_option";

interface WaitingRequest {
  readonly optionIds: ReadonlySet<string>;
  readonly timer: NodeJS.Timeout;
  settle(outcome: PermissionWaitOutcome): void;
}

/**
 * How long a request waits for a person before its caller falls back. Long
 * enough that a headset put down mid-turn can still be picked up, short enough
 * that an unattended backend settles the turn the same day.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

/**
 * How many requests one session may hold at once. A conforming agent asks about
 * one action at a time; the cap is what keeps a looping or hostile one from
 * growing this map without bound.
 */
const DEFAULT_MAX_PER_SESSION = 8;

export class PendingPermissionRequests {
  private readonly bySession = new Map<string, Map<string, WaitingRequest>>();
  private readonly timeoutMs: number;
  private readonly maxPerSession: number;

  constructor(options: { timeoutMs?: number; maxPerSession?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  /**
   * Hold `requestId` open for this session until a human answers it, the wait
   * times out, or the session is released.
   *
   * Returning `undefined` means no wait was opened: an empty vocabulary cannot
   * be answered, and a full session cannot admit another request. The caller
   * must apply its own configured policy and, crucially, must not advertise an
   * answer route for that request.
   *
   * A returned promise means the request is already registered synchronously,
   * before this method returns. The caller can therefore publish its id and
   * options without racing a fast client answer.
   */
  wait(input: {
    sessionKey: string;
    requestId: string;
    options: readonly PermissionRequestOption[];
  }): Promise<PermissionWaitOutcome> | undefined {
    if (input.options.length === 0) return undefined;
    const requests = this.bySession.get(input.sessionKey) ?? new Map<string, WaitingRequest>();
    if (requests.size >= this.maxPerSession) return undefined;
    this.bySession.set(input.sessionKey, requests);

    return new Promise<PermissionWaitOutcome>((resolve) => {
      const settle = (outcome: PermissionWaitOutcome): void => {
        const pending = this.bySession.get(input.sessionKey);
        pending?.delete(input.requestId);
        if (pending?.size === 0) this.bySession.delete(input.sessionKey);
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle({ decidedBy: "timeout" }), this.timeoutMs);
      timer.unref?.();
      requests.set(input.requestId, {
        optionIds: new Set(input.options.map((option) => option.optionId)),
        timer,
        settle
      });
    });
  }

  /**
   * Answer an outstanding request with an option the agent offered.
   *
   * An option id that was not among them is refused rather than forwarded: the
   * agent decides what it is willing to be told, and inventing a value it never
   * supplied is the one thing this channel must never do.
   */
  answer(sessionKey: string, requestId: string, optionId: string): PermissionAnswerResult {
    const request = this.bySession.get(sessionKey)?.get(requestId);
    if (!request) return "unknown_request";
    if (!request.optionIds.has(optionId)) return "unknown_option";
    request.settle({ decidedBy: "human", optionId });
    return "answered";
  }

  /** Settle everything this session holds, so no wait outlives it. */
  releaseSession(sessionKey: string): void {
    const requests = this.bySession.get(sessionKey);
    if (!requests) return;
    for (const request of [...requests.values()]) request.settle({ decidedBy: "timeout" });
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
