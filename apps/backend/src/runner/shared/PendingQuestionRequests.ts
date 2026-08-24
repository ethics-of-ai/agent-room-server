import { PendingRequests } from "./PendingRequests";

/**
 * Outstanding clarifying-question batches waiting for a human answer.
 *
 * A runner that is unsure which way to go can pause its turn and ask: one
 * *batch* of one or more *sets*, each set a prompt with selectable options and,
 * where the set allows it, a free-text "discuss further" escape. The person
 * answers the sets they can and submits the batch once; the turn continues
 * with the answers. This is the waiting half of that channel, the sibling of
 * `PendingPermissionRequests` on the same `PendingRequests` core, and it owns
 * two things the core does not: the bounds a batch must fit, and the answer
 * validation — every selected option must be one the agent offered for that
 * set, a single-select set takes at most one, and free text is accepted only
 * where the set offered it.
 *
 * Answering a question authorizes nothing: it is the user's own words and
 * choices going back to an agent that asked for them, the same class of input
 * as the turn message. What the channel must still never do is put words in the
 * user's mouth — so a timeout is reported as a timeout, never as a default
 * choice, and a released request (cancelled turn, closed session) is reported
 * as cancelled.
 */

/**
 * Bounds shared by the runner boundary, the wire projection, and the answer
 * route. Ids are AgentRoom-minted and short; the bound exists so a client
 * cannot push an arbitrary string through the route, not because the backend
 * ever mints one this long.
 */
export const MAX_QUESTION_SETS = 8;
export const MAX_QUESTION_OPTIONS = 8;
export const MAX_QUESTION_ID_LENGTH = 200;
export const MAX_QUESTION_HEADER_LENGTH = 24;
export const MAX_QUESTION_PROMPT_LENGTH = 1000;
export const MAX_QUESTION_LABEL_LENGTH = 200;
export const MAX_QUESTION_DESCRIPTION_LENGTH = 500;
export const MAX_QUESTION_DISCUSSION_LENGTH = 4000;

/**
 * How long a batch waits for a person before the runner's own away fallback
 * applies. Longer than a permission request's five minutes: a question asks for
 * a decision, and a headset put down to think about one should still find the
 * turn waiting.
 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60_000;

/**
 * How many batches one session may hold at once. A blocking agent asks one
 * batch at a time; the cap keeps a non-blocking or looping one from growing the
 * table without bound.
 */
const DEFAULT_MAX_PER_SESSION = 8;

export type QuestionSelection = "single" | "multiple";
/** Whether a set offers the free-text escape, and whether it is the only answer. */
export type QuestionDiscussion = "none" | "optional" | "required";

export interface QuestionRequestOption {
  optionId: string;
  label: string;
  description?: string;
}

export interface QuestionRequestSet {
  setId: string;
  /** A short chip label (a runner's `header`), when it supplied one. */
  header?: string;
  prompt: string;
  selection: QuestionSelection;
  /** Empty only when `discussion` is `"required"` — a free-text-only set. */
  options: QuestionRequestOption[];
  discussion: QuestionDiscussion;
  /** Free text the user types here is never echoed into events, messages, or audit. */
  sensitive?: boolean;
}

export interface QuestionSetAnswer {
  setId: string;
  selectedOptionIds: string[];
  discussion?: string;
}

/** Who decided a question batch. Reported on the resolved event and audited. */
export type QuestionDecisionAuthority = "human" | "timeout";

export type QuestionWaitOutcome =
  | { status: "answered"; decidedBy: "human"; answers: QuestionSetAnswer[] }
  /** The clock ran out; the runner applies its own away fallback. */
  | { status: "timeout"; decidedBy: "timeout" }
  /** The turn, child, or session released it; nobody decided. */
  | { status: "cancelled" };

export type QuestionAnswerResult =
  | "answered"
  | "unknown_request"
  | "empty_batch"
  | "unknown_set"
  | "duplicate_set"
  | "unknown_option"
  | "duplicate_option"
  | "selection_limit"
  | "discussion_not_offered"
  | "discussion_required"
  | "empty_answer";

interface QuestionEntry {
  readonly sets: readonly QuestionRequestSet[];
}

/**
 * Whether a set can be answered at all: something to choose, or free text
 * required in place of a choice. A set with neither would hold a wait nobody
 * can settle.
 */
export function isAnswerableQuestionSet(set: QuestionRequestSet): boolean {
  return set.options.length > 0 || set.discussion === "required";
}

/**
 * Validate the complete model-authored vocabulary before a wait is opened.
 * The wire mapper also validates its projection, but doing it here is what
 * keeps the pending store, reconnect read, transcript, and live event on the
 * same bounded strings instead of clamping only the copy a client sees.
 */
export function isValidQuestionRequestBatch(sets: readonly QuestionRequestSet[]): boolean {
  if (sets.length === 0 || sets.length > MAX_QUESTION_SETS) return false;
  const seenSetIds = new Set<string>();
  for (const set of sets) {
    if (!boundedNonBlank(set.setId, MAX_QUESTION_ID_LENGTH) || seenSetIds.has(set.setId)) return false;
    seenSetIds.add(set.setId);
    if (set.header !== undefined && set.header.length > MAX_QUESTION_HEADER_LENGTH) return false;
    if (!boundedNonBlank(set.prompt, MAX_QUESTION_PROMPT_LENGTH)) return false;
    if (set.selection !== "single" && set.selection !== "multiple") return false;
    if (set.discussion !== "none" && set.discussion !== "optional" && set.discussion !== "required") return false;
    if (set.options.length > MAX_QUESTION_OPTIONS || !isAnswerableQuestionSet(set)) return false;

    const seenOptionIds = new Set<string>();
    for (const option of set.options) {
      if (!boundedNonBlank(option.optionId, MAX_QUESTION_ID_LENGTH) || seenOptionIds.has(option.optionId)) return false;
      seenOptionIds.add(option.optionId);
      if (!boundedNonBlank(option.label, MAX_QUESTION_LABEL_LENGTH)) return false;
      if (option.description !== undefined && option.description.length > MAX_QUESTION_DESCRIPTION_LENGTH) return false;
    }
  }
  return true;
}

/**
 * Validate a batch answer against the sets the agent offered. Pure, so the
 * route's error messages and the store's refusal cannot disagree. Sets the
 * answer omits are simply unanswered; every set it names must be valid.
 */
export function validateQuestionAnswers(
  sets: readonly QuestionRequestSet[],
  answers: readonly QuestionSetAnswer[]
): QuestionAnswerResult {
  if (answers.length === 0) return "empty_batch";
  const setsById = new Map(sets.map((set) => [set.setId, set] as const));
  const seenSets = new Set<string>();
  for (const answer of answers) {
    const set = setsById.get(answer.setId);
    if (!set) return "unknown_set";
    if (seenSets.has(answer.setId)) return "duplicate_set";
    seenSets.add(answer.setId);

    const offered = new Set(set.options.map((option) => option.optionId));
    const seenOptions = new Set<string>();
    for (const optionId of answer.selectedOptionIds) {
      if (!offered.has(optionId)) return "unknown_option";
      if (seenOptions.has(optionId)) return "duplicate_option";
      seenOptions.add(optionId);
    }
    if (set.selection === "single" && answer.selectedOptionIds.length > 1) return "selection_limit";

    const discussion = answer.discussion?.trim() ?? "";
    if (discussion.length > 0 && set.discussion === "none") return "discussion_not_offered";
    if (set.discussion === "required" && discussion.length === 0) return "discussion_required";
    if (answer.selectedOptionIds.length === 0 && discussion.length === 0) return "empty_answer";
  }
  return "answered";
}

export class PendingQuestionRequests {
  private readonly requests: PendingRequests<QuestionEntry, QuestionWaitOutcome>;

  constructor(options: { timeoutMs?: number; maxPerSession?: number } = {}) {
    this.requests = new PendingRequests<QuestionEntry, QuestionWaitOutcome>({
      timeoutMs: options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
      maxPerSession: options.maxPerSession ?? DEFAULT_MAX_PER_SESSION,
      onTimeout: () => ({ status: "timeout", decidedBy: "timeout" }),
      onRelease: () => ({ status: "cancelled" })
    });
  }

  /**
   * Hold a batch open for this session until a human answers it, the wait
   * times out, or it is cancelled or released.
   *
   * Returning `undefined` means no wait was opened — no sets, a set nobody
   * could answer, or a full session — and the caller must apply its own
   * fallback without advertising the id as answerable. A returned promise means
   * the request is registered synchronously, so the caller can publish the id
   * and sets without racing a fast client answer.
   */
  wait(input: {
    sessionKey: string;
    requestId: string;
    sets: readonly QuestionRequestSet[];
  }): Promise<QuestionWaitOutcome> | undefined {
    if (!isValidQuestionRequestBatch(input.sets)) return undefined;
    return this.requests.open(input.sessionKey, input.requestId, { sets: input.sets });
  }

  /**
   * Answer an outstanding batch. Every named set and option must be one the
   * agent offered; a set the answer omits stays unanswered and is reported to
   * the agent as such.
   */
  answer(sessionKey: string, requestId: string, answers: readonly QuestionSetAnswer[]): QuestionAnswerResult {
    const entry = this.requests.entry(sessionKey, requestId);
    if (!entry) return "unknown_request";
    const result = validateQuestionAnswers(entry.sets, answers);
    if (result !== "answered") return result;
    this.requests.settle(sessionKey, requestId, {
      status: "answered",
      decidedBy: "human",
      answers: answers.map((answer) => ({
        setId: answer.setId,
        selectedOptionIds: [...answer.selectedOptionIds],
        ...(answer.discussion?.trim() ? { discussion: answer.discussion } : {})
      }))
    });
    return "answered";
  }

  /** The sets an outstanding batch holds, for re-seeding a late-joining client. */
  outstanding(sessionKey: string, requestId: string): readonly QuestionRequestSet[] | undefined {
    return this.requests.entry(sessionKey, requestId)?.sets;
  }

  /** Release one batch unanswered: the turn was cancelled or the call aborted. */
  cancel(sessionKey: string, requestId: string): boolean {
    return this.requests.release(sessionKey, requestId);
  }

  /** Settle everything this session holds, so no wait outlives it. */
  releaseSession(sessionKey: string): void {
    this.requests.releaseSession(sessionKey);
  }

  releaseAll(): void {
    this.requests.releaseAll();
  }

  /** Outstanding batch count, for bounds assertions in tests. */
  pendingCount(sessionKey: string): number {
    return this.requests.pendingCount(sessionKey);
  }
}

function boundedNonBlank(value: string, maxLength: number): boolean {
  return value.length <= maxLength && value.trim().length > 0;
}
