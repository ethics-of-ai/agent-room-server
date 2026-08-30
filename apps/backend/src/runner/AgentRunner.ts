import type { AgentRunnerKind, CodingAgentCapabilities, CodingAgentTurnSettings } from "../domain/models";
import type {
  PermissionAnswerResult,
  PermissionDecisionAuthority,
  PermissionRequestOption
} from "./shared/PendingPermissionRequests";
import type {
  QuestionAnswerResult,
  QuestionDecisionAuthority,
  QuestionRequestOption,
  QuestionRequestSet,
  QuestionSetAnswer
} from "./shared/PendingQuestionRequests";

export type CanonicalPermissionOption = PermissionRequestOption;
export type CanonicalQuestionOption = QuestionRequestOption;
export type CanonicalQuestionSet = QuestionRequestSet;
export type CanonicalQuestionAnswer = QuestionSetAnswer;

export type AgentRunnerInputPart =
  | {
      type: "localImage";
      path: string;
      // Image media type (e.g. "image/png"). Codex reads the file itself, but
      // the Claude Agent SDK needs a base64 block with an explicit media_type.
      contentType?: string;
    };

export class AgentRunnerInputError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface AgentRunnerInput {
  runId: string;
  sessionId?: string;
  workspacePath: string;
  prompt: string;
  inputParts?: AgentRunnerInputPart[];
  title?: string;
  settings?: CodingAgentTurnSettings;
}

export interface RunnerAudit {
  phase: "started" | "completed";
  runnerKind: AgentRunnerKind;
  runId: string;
  command: {
    executableName: string;
    argsCount: number;
  };
  status?: "succeeded" | "failed";
  exitStatus?: {
    code: number | null;
    signal: NodeJS.Signals | null;
  };
  durationMs?: number;
  timeToFirstEventMs?: number;
  timeToFirstOutputMs?: number;
  streamDurationMs?: number;
  maxOutputGapMs?: number;
  eventCount?: number;
  outputEventCount?: number;
  outputBytes?: number;
  activityEventCount?: number;
  failureCategory?: "process_error" | "process_exit" | "process_signal";
}

export interface CanonicalPlanStep {
  step: string;
  status: string;
}

export interface CanonicalDiffFile {
  path: string;
  /** The pre-rename path, when the runner's diff reports one. */
  oldPath?: string;
  status: string;
  additions?: number;
  deletions?: number;
}

/**
 * The runner-agnostic payload of one activity. An adapter maps its own protocol
 * into this discriminated union; nothing above the `AgentRunner` boundary reads
 * a native kind to decide what an activity *is*.
 *
 * This is deliberately a payload union and not a tag beside vendor-shaped
 * content: a tag alone would only move the conditional from `runnerKind` to
 * content inspection. Native detail is preserved beside it — the activity's
 * `kind`/`content` and the `native` blob on {@link RunnerMetadata} — so
 * generalizing the dispatch never costs the payload.
 */
export type CanonicalActivity =
  | { kind: "session_started" }
  | { kind: "turn_started" }
  | { kind: "plan_updated"; explanation?: string; steps: CanonicalPlanStep[] }
  | { kind: "diff_updated"; summary?: string; files: CanonicalDiffFile[]; truncated?: boolean }
  | { kind: "reasoning"; delta?: string }
  | { kind: "tool_started"; toolId?: string }
  | { kind: "tool_output"; toolId?: string; delta?: string }
  | { kind: "tool_completed"; toolId?: string }
  | {
      kind: "permission_requested";
      /**
       * The id a client answers this request at. Backend-minted rather than the
       * agent's own, because the answer route addresses it and an agent's id
       * space is its own business.
       */
      requestId?: string;
      /** Only options the agent itself offered; a client may choose no other. */
      options?: CanonicalPermissionOption[];
      request: Record<string, unknown>;
    }
  | {
      kind: "permission_resolved";
      requestId?: string;
      status?: string;
      /** The option that was selected, when one was. */
      optionId?: string;
      /** Who decided it — a person, the configured policy, or the bounded wait. */
      decidedBy?: PermissionDecisionAuthority;
    }
  | {
      kind: "question_requested";
      /**
       * The id a client answers this batch at. Present only while the backend
       * holds the batch open; a batch announced without one is a record, not
       * something a client can answer. Backend-minted, like every set and
       * option id inside it, so nothing a client sends is an id the agent
       * interprets.
       */
      requestId?: string;
      questionSets: CanonicalQuestionSet[];
    }
  | {
      kind: "question_resolved";
      requestId?: string;
      /** `answered`, `timeout`, or `cancelled`. */
      status?: string;
      /** A person, or the bounded wait. Absent when nobody decided (cancelled). */
      decidedBy?: QuestionDecisionAuthority;
      /** What was chosen, per answered set. A sensitive set's text is never here. */
      questionAnswers?: CanonicalQuestionAnswer[];
    }
  | { kind: "context_compaction_started" }
  | {
      /**
       * The runner has summarized its own conversation and is now holding less
       * of it. Every field is optional because the runners report different
       * amounts: Claude Code gives the trigger and both counts, Codex may give
       * none, and Cursor gives only that it happened.
       *
       * What is deliberately absent is the summary itself. It is the model's
       * own account of everything the thread has done, and it stops at the
       * adapter — see `docs/safety/TRUST_AND_SAFETY.md`.
       */
      kind: "context_compaction_completed";
      trigger?: "auto" | "manual";
      preTokens?: number;
      postTokens?: number;
      /** The compaction was attempted and did not succeed. */
      failed?: boolean;
    };

export type CanonicalActivityKind = CanonicalActivity["kind"];

/**
 * Correlation and display metadata an adapter attaches to what it emits.
 *
 * The named fields are canonical: a client correlates and renders from these
 * alone, without knowing which runner produced them. `native` carries the
 * richer per-runner detail that has no canonical home (a JSON-RPC method name,
 * an SDK message uuid) and is bounded on construction — it is never required
 * for baseline correlation or rendering, and the legacy `codex`/`claudeCode`
 * wire blocks are rebuilt from it by the compatibility shim in
 * `protocol/coding/legacyMetadata.ts`.
 *
 * `posture` is display metadata, deliberately not a universal permission enum:
 * an adapter supplies its runner's own label and value, so a Codex approval
 * policy and a Claude Code permission mode stay distinct rather than being
 * flattened into a lossy common denominator.
 */
export interface RunnerMetadata {
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  model?: string;
  cwd?: string;
  posture?: { label: string; value: string };
  sandbox?: unknown;
  native?: Record<string, unknown>;
}

export interface AgentRunnerActivity {
  /**
   * The adapter's own name for this activity. Display and diagnostic only —
   * `canonical` is what decides behavior.
   */
  kind: string;
  title: string;
  description?: string;
  content: Record<string, unknown>;
  /**
   * Absent means the adapter has no canonical reading of this activity: it
   * still rides the legacy `agent_turn_activity` event, but produces no
   * `coding_*` event. That is how a runner keeps an activity out of the
   * canonical stream without the core mapper knowing why.
   */
  canonical?: CanonicalActivity;
  runner?: RunnerMetadata;
}

export type AgentRunnerEvent =
  | {
      type: "runner_audit";
      audit: RunnerAudit;
    }
  | {
      type: "agent_activity";
      activity: AgentRunnerActivity;
    }
  | {
      type: "agent_update";
      message: string;
      runner?: RunnerMetadata;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | {
      type: "token_usage_updated";
      runner?: RunnerMetadata;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
      totalTokens?: number;
      /**
       * Live context-window occupancy: the most recent model request's token
       * footprint, not the cumulative billed totals above. Cumulative totals
       * re-count the (cached) conversation on every tool round-trip, so they
       * overstate occupancy by roughly a factor of the request count.
       */
      contextWindowUsedTokens?: number;
      modelContextWindowTokens?: number;
      /**
       * Where this runner's own auto-compaction fires. Absent means the runner
       * supplied no new knowledge; null explicitly clears a value it reported
       * earlier. Codex keeps its limit internal and Cursor summarizes on a
       * schedule it does not publish, so a reader shows absence rather than a
       * line AgentRoom picked. Only the reporting runner can supply it.
       */
      contextCompactionThresholdTokens?: number | null;
    }
  | {
      type: "run_succeeded";
      message?: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | {
      type: "run_failed";
      error: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };

export interface AgentRunner {
  getCapabilities(): Promise<CodingAgentCapabilities>;
  validateInputParts(inputParts: AgentRunnerInputPart[] | undefined): void;
  run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent>;
  cancel(runId: string): Promise<void>;
  /**
   * Answer an outstanding permission request with an option the runner is
   * currently holding for it.
   *
   * Optional, because a runner that never asks — or that answers from a stored
   * policy alone — has nothing to answer. Its absence is what the answer route
   * reports as "no such outstanding request", rather than anything about which
   * runner this is.
   */
  answerPermissionRequest?(input: {
    sessionId: string;
    requestId: string;
    optionId: string;
  }): PermissionAnswerResult;
  /**
   * Answer an outstanding clarifying-question batch with selections from the
   * sets the runner is holding for it, and the user's own free text where a set
   * offered it.
   *
   * Optional for the same reason as `answerPermissionRequest`: a runner with no
   * native way to ask has nothing outstanding, and its absence reads as "no such
   * request" rather than as anything about which runner this is.
   */
  answerQuestionRequest?(input: {
    sessionId: string;
    requestId: string;
    answers: CanonicalQuestionAnswer[];
  }): QuestionAnswerResult;
  /**
   * Seed the native id this runner would resume an AgentRoom session's
   * conversation with, before any child for it exists in this process.
   *
   * The service calls it once per session it hydrated from the durable store
   * at startup, so the next turn takes the same acquire-miss resume branch a
   * reaped or crashed child takes. It remembers; it spawns nothing. Restoring
   * stays in the adapter, with the same explicit runtime settings and
   * isolation posture as a fresh start.
   *
   * Optional, like the two answer hooks: a runner whose descriptor declares
   * `restoreStrategy: "unsupported"` has no resume token to hold, and its
   * absence is what the service reads — never which runner this is.
   */
  rememberResumableId?(input: {
    sessionId: string;
    nativeSessionId: string;
    /**
     * The persisted turn was running when the backend ended. A runner whose
     * native side can be left mid-run (Cursor's persisted active run) uses it
     * to take the same recovery it takes for a child that died with a send in
     * flight.
     */
    interrupted: boolean;
  }): void;
  // Release per-session runner resources (persistent child processes, queues)
  // when the AgentRoom session is deleted.
  closeSession?(sessionId: string): Promise<void>;
  dispose?(): Promise<void>;
}
