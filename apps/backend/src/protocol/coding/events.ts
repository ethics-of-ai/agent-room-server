import { z } from "zod";
import type { AgentRunnerActivity, RunnerMetadata } from "../../runner/AgentRunner";
import type { RunnerSessionMetadata } from "../../domain/models";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_REQUEST_ID_LENGTH
} from "../../runner/shared/PendingPermissionRequests";
import {
  MAX_QUESTION_DESCRIPTION_LENGTH,
  MAX_QUESTION_DISCUSSION_LENGTH,
  MAX_QUESTION_HEADER_LENGTH,
  MAX_QUESTION_ID_LENGTH,
  MAX_QUESTION_LABEL_LENGTH,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_PROMPT_LENGTH,
  MAX_QUESTION_SETS
} from "../../runner/shared/PendingQuestionRequests";
import type { CanonicalQuestionAnswer, CanonicalQuestionSet } from "../../runner/AgentRunner";
import {
  codingActivitySchema,
  codingAgentEventPayloadSchema,
  codingDiffFileSchema,
  codingPermissionOptionsSchema,
  codingQuestionAnswersSchema,
  codingQuestionSetsSchema
} from "./eventSchemas";
import type {
  CodingAgentEventCandidate,
  CodingAgentEventPayload,
  CodingArtifactKind,
  CodingCanonicalActivity,
  CodingRunnerMetadata
} from "./eventSchemas";
import { boundedRunnerMetadata, legacyClaudeCodeMetadata, legacyCodexMetadata } from "./legacyMetadata";

export {
  CODING_EVENT_CONTRACT_VERSION,
  codingAgentEventPayloadSchema,
  codingAgentEventTypeSchema,
  codingArtifactKindSchema,
  codingCanonicalActivitySchema,
  codingClaudeCodeMetadataSchema,
  codingCodexMetadataSchema,
  codingPermissionOptionSchema,
  codingQuestionAnswerSchema,
  codingQuestionOptionSchema,
  codingQuestionSetSchema,
  codingRunnerMetadataSchema
} from "./eventSchemas";
export type {
  CodingAgentEventCandidate,
  CodingAgentEventPayload,
  CodingAgentEventType,
  CodingArtifactKind,
  CodingCanonicalActivity,
  CodingRunnerMetadata
} from "./eventSchemas";

const MAX_TEXT_LENGTH = 1_000;
// Artifact body deltas can legitimately be large (a whole inline SVG can arrive
// in one coalesced runner chunk), so they are not held to the chat-text clamp.
// A single WS frame is still capped to one artifact's worth as a transport
// safety bound. The caller only ever emits a delta the ArtifactStore actually
// retained (see AgentTurnEventApplier.applyArtifactOps), so the live stream and
// the stored snapshot stay in agreement even when the per-artifact byte cap is
// hit; this clamp is a defensive ceiling, not the source of truth.
const MAX_ARTIFACT_DELTA_LENGTH = 64 * 1024;
const MAX_PLAN_STEPS = 50;
const MAX_DIFF_FILES = 100;

interface CodingEventBaseInput {
  sessionId: string;
  turnId?: string;
  /**
   * The session's pinned runner id. It labels the event and selects which
   * legacy block the compatibility shim rebuilds; nothing in this module
   * branches on it to decide *behavior*.
   */
  runnerKind: string;
  runner?: RunnerMetadata;
}

export function codingAssistantMessageDeltaEvent(input: CodingEventBaseInput & { delta: string }): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_assistant_message_delta",
    turnId: input.turnId,
    delta: clampText(input.delta)
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingArtifactStartedEvent(input: CodingEventBaseInput & {
  artifactId: string;
  kind: CodingArtifactKind;
  title?: string;
}): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_artifact_started",
    turnId: input.turnId,
    artifactId: clampText(input.artifactId),
    kind: input.kind,
    ...(input.title ? { title: clampText(input.title) } : {})
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingArtifactDeltaEvent(input: CodingEventBaseInput & {
  artifactId: string;
  delta: string;
}): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  // Each event carries one clamped delta slice; the accumulated artifact body is
  // bounded by ArtifactStore, not here, so the live stream stays many small sends.
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_artifact_delta",
    turnId: input.turnId,
    artifactId: clampText(input.artifactId),
    delta: clampText(input.delta, MAX_ARTIFACT_DELTA_LENGTH)
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingArtifactCompletedEvent(input: CodingEventBaseInput & {
  artifactId: string;
  bytes?: number;
  truncated?: boolean;
}): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_artifact_completed",
    turnId: input.turnId,
    artifactId: clampText(input.artifactId),
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    ...(input.truncated ? { truncated: true } : {})
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingTokenUsageUpdatedEvent(input: CodingEventBaseInput & {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindowUsedTokens?: number;
  modelContextWindowTokens?: number;
}): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_token_usage_updated",
    turnId: input.turnId,
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: input.reasoningOutputTokens } : {}),
    ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    ...(input.contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens: input.contextWindowUsedTokens } : {}),
    ...(input.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: input.modelContextWindowTokens } : {})
  });
  return payload ? { type: payload.type, payload } : undefined;
}

/// Backend-derived diff summary for runners that report no turn diff of their
/// own (currently the Claude Code settle-time Git delta). Codex diffs arrive
/// through `codingEventFromRunnerActivity` instead; both paths share the same
/// bounded payload shape and file cap.
export function codingDiffUpdatedEvent(input: CodingEventBaseInput & {
  summary?: string;
  files: Array<z.infer<typeof codingDiffFileSchema>>;
  truncated?: boolean;
}): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const files = input.files.slice(0, MAX_DIFF_FILES).map((file) => ({
    path: clampText(file.path),
    ...(file.oldPath !== undefined ? { oldPath: clampText(file.oldPath) } : {}),
    status: clampText(file.status),
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {})
  }));
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_diff_updated",
    turnId: input.turnId,
    ...(input.summary ? { summary: clampText(input.summary) } : {}),
    files,
    ...(input.truncated || input.files.length > MAX_DIFF_FILES ? { truncated: true } : {})
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingTurnCompletedEvent(input: CodingEventBaseInput): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_turn_completed",
    turnId: input.turnId
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingTurnFailedEvent(input: CodingEventBaseInput & { error: string }): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_turn_failed",
    turnId: input.turnId,
    error: clampText(input.error)
  });
  return payload ? { type: payload.type, payload } : undefined;
}

export function codingTurnCancelledEvent(input: CodingEventBaseInput): CodingAgentEventCandidate | undefined {
  if (!input.turnId) return undefined;
  const payload = parsePayload({
    ...basePayload(input),
    type: "coding_turn_cancelled",
    turnId: input.turnId
  });
  return payload ? { type: payload.type, payload } : undefined;
}

/**
 * Map one runner activity onto its canonical `coding_*` event.
 *
 * This function is the whole point of the canonical union: it dispatches on
 * `activity.canonical.kind` and never on which runner produced the activity.
 * An adapter that emits no canonical reading produces no event here — that is
 * how a runner keeps an activity out of the canonical stream (a non-renderable
 * Codex item, say) without this module learning why.
 */
export function codingEventFromRunnerActivity(
  input: CodingEventBaseInput & { activity: AgentRunnerActivity }
): CodingAgentEventCandidate | undefined {
  const canonical = input.activity.canonical;
  if (!canonical) return undefined;
  const base = basePayload({ ...input, runner: input.activity.runner });

  if (canonical.kind === "session_started") {
    return candidate(parsePayload({ ...base, type: "coding_session_started" }));
  }

  if (!input.turnId) return undefined;
  const turnId = input.turnId;

  switch (canonical.kind) {
    case "turn_started":
      return candidate(parsePayload({ ...base, type: "coding_turn_started", turnId }));
    case "plan_updated":
      return candidate(parsePayload({
        ...base,
        type: "coding_plan_updated",
        turnId,
        ...(canonical.explanation ? { explanation: clampText(canonical.explanation) } : {}),
        plan: canonical.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
          step: clampText(step.step),
          status: clampText(step.status)
        }))
      }));
    case "diff_updated":
      return candidate(parsePayload({
        ...base,
        type: "coding_diff_updated",
        turnId,
        ...(canonical.summary ? { summary: clampText(canonical.summary) } : {}),
        files: boundedDiffFiles(canonical.files),
        ...(canonical.truncated || canonical.files.length > MAX_DIFF_FILES ? { truncated: true } : {})
      }));
    case "reasoning":
    case "tool_output":
      return candidate(parsePayload({
        ...base,
        type: "coding_tool_activity_updated",
        turnId,
        ...(canonical.delta ? { delta: clampText(canonical.delta) } : {}),
        activity: normalizedActivity(input.activity, input.runnerKind)
      }));
    case "tool_started":
      return candidate(parsePayload({
        ...base,
        type: "coding_tool_activity_started",
        turnId,
        activity: normalizedActivity(input.activity, input.runnerKind)
      }));
    case "tool_completed":
      return candidate(parsePayload({
        ...base,
        type: "coding_tool_activity_completed",
        turnId,
        activity: normalizedActivity(input.activity, input.runnerKind)
      }));
    case "permission_requested":
      return candidate(parsePayload({
        ...base,
        type: "coding_permission_requested",
        turnId,
        ...answerablePermissionFields(canonical.requestId, canonical.options),
        request: boundedRecord(canonical.request)
      }));
    case "permission_resolved":
      return candidate(parsePayload({
        ...base,
        type: "coding_permission_resolved",
        turnId,
        ...(canonical.requestId ? { requestId: clampText(canonical.requestId, MAX_PERMISSION_REQUEST_ID_LENGTH) } : {}),
        ...(canonical.status ? { status: clampText(canonical.status) } : {}),
        ...(canonical.optionId ? { optionId: clampText(canonical.optionId, MAX_PERMISSION_OPTION_ID_LENGTH) } : {}),
        ...(canonical.decidedBy ? { decidedBy: clampText(canonical.decidedBy) } : {})
      }));
    case "question_requested": {
      const questionSets = boundedQuestionSets(canonical.questionSets);
      if (!questionSets) return undefined;
      return candidate(parsePayload({
        ...base,
        type: "coding_question_requested",
        turnId,
        ...answerableQuestionRequestId(canonical.requestId),
        questionSets
      }));
    }
    case "question_resolved":
      return candidate(parsePayload({
        ...base,
        type: "coding_question_resolved",
        turnId,
        ...answerableQuestionRequestId(canonical.requestId),
        ...(canonical.status ? { status: clampText(canonical.status) } : {}),
        ...(canonical.decidedBy ? { decidedBy: clampText(canonical.decidedBy) } : {}),
        ...boundedQuestionAnswers(canonical.questionAnswers)
      }));
  }
}

/**
 * The session-wide metadata an adapter reports when its native session starts.
 * Keyed on the canonical `session_started` payload, so a third runner's session
 * block is recorded without this module knowing its activity kinds.
 */
export function runnerSessionMetadataFromActivity(activity: AgentRunnerActivity): RunnerSessionMetadata | undefined {
  if (activity.canonical?.kind !== "session_started") return undefined;
  const runner = boundedRunnerMetadata(activity.runner);
  if (!runner) return undefined;
  return {
    ...(runner.nativeSessionId ? { nativeSessionId: runner.nativeSessionId } : {}),
    ...(runner.model ? { model: runner.model } : {}),
    ...(runner.cwd ? { cwd: runner.cwd } : {}),
    ...(runner.posture ? { posture: runner.posture } : {}),
    ...(runner.sandbox !== undefined ? { sandbox: runner.sandbox } : {})
  };
}

function basePayload(input: CodingEventBaseInput): Omit<CodingAgentEventPayload, "type"> {
  const runner = boundedRunnerMetadata(input.runner);
  const codex = legacyCodexMetadata(input.runnerKind, runner);
  const claudeCode = legacyClaudeCodeMetadata(input.runnerKind, runner);
  return {
    version: 1,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    runnerKind: input.runnerKind,
    ...(runner ? { runner } : {}),
    ...(codex ? { codex } : {}),
    ...(claudeCode ? { claudeCode } : {})
  };
}

function candidate(payload: CodingAgentEventPayload | undefined): CodingAgentEventCandidate | undefined {
  return payload ? { type: payload.type, payload } : undefined;
}

function parsePayload(payload: unknown): CodingAgentEventPayload | undefined {
  const parsed = codingAgentEventPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function boundedDiffFiles(files: Array<z.infer<typeof codingDiffFileSchema>>): Array<z.infer<typeof codingDiffFileSchema>> {
  return files.slice(0, MAX_DIFF_FILES).map((file) => ({
    path: clampText(file.path),
    ...(file.oldPath !== undefined ? { oldPath: clampText(file.oldPath) } : {}),
    status: clampText(file.status),
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {})
  }));
}

function normalizedActivity(
  activity: AgentRunnerActivity,
  runnerKind: string
): z.infer<typeof codingActivitySchema> {
  const runner = boundedRunnerMetadata(activity.runner);
  const codex = legacyCodexMetadata(runnerKind, runner);
  const claudeCode = legacyClaudeCodeMetadata(runnerKind, runner);
  return {
    kind: clampText(activity.kind),
    title: clampText(activity.title),
    ...(activity.description ? { description: clampText(activity.description) } : {}),
    content: boundedRecord(activity.content),
    ...(activity.canonical ? { canonical: boundedCanonicalActivity(activity.canonical) } : {}),
    ...(runner ? { runner } : {}),
    ...(codex ? { codex } : {}),
    ...(claudeCode ? { claudeCode } : {})
  };
}

/// The canonical payload repeated inside the activity block, clamped to the
/// same ceilings as the top-level fields it mirrors so an activity can never
/// smuggle an unbounded string past them.
function boundedCanonicalActivity(canonical: CodingCanonicalActivity): CodingCanonicalActivity {
  switch (canonical.kind) {
    case "plan_updated":
      return {
        kind: "plan_updated",
        ...(canonical.explanation ? { explanation: clampText(canonical.explanation) } : {}),
        steps: canonical.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
          step: clampText(step.step),
          status: clampText(step.status)
        }))
      };
    case "diff_updated":
      return {
        kind: "diff_updated",
        ...(canonical.summary ? { summary: clampText(canonical.summary) } : {}),
        files: boundedDiffFiles(canonical.files),
        ...(canonical.truncated || canonical.files.length > MAX_DIFF_FILES ? { truncated: true } : {})
      };
    case "reasoning":
      return { kind: "reasoning", ...(canonical.delta ? { delta: clampText(canonical.delta) } : {}) };
    case "tool_output":
      return {
        kind: "tool_output",
        ...(canonical.toolId ? { toolId: clampText(canonical.toolId) } : {}),
        ...(canonical.delta ? { delta: clampText(canonical.delta) } : {})
      };
    case "tool_started":
    case "tool_completed":
      return { kind: canonical.kind, ...(canonical.toolId ? { toolId: clampText(canonical.toolId) } : {}) };
    case "permission_requested":
      return {
        kind: "permission_requested",
        ...answerablePermissionFields(canonical.requestId, canonical.options),
        request: boundedRecord(canonical.request)
      };
    case "permission_resolved":
      return {
        kind: "permission_resolved",
        ...(canonical.requestId ? { requestId: clampText(canonical.requestId, MAX_PERMISSION_REQUEST_ID_LENGTH) } : {}),
        ...(canonical.status ? { status: clampText(canonical.status) } : {}),
        ...(canonical.optionId ? { optionId: clampText(canonical.optionId, MAX_PERMISSION_OPTION_ID_LENGTH) } : {}),
        ...(canonical.decidedBy ? { decidedBy: clampText(canonical.decidedBy) } : {})
      };
    case "question_requested":
      return {
        kind: "question_requested",
        ...answerableQuestionRequestId(canonical.requestId),
        questionSets: boundedQuestionSets(canonical.questionSets) ?? []
      };
    case "question_resolved":
      return {
        kind: "question_resolved",
        ...answerableQuestionRequestId(canonical.requestId),
        ...(canonical.status ? { status: clampText(canonical.status) } : {}),
        ...(canonical.decidedBy ? { decidedBy: clampText(canonical.decidedBy) } : {}),
        ...boundedQuestionAnswers(canonical.questionAnswers)
      };
    default:
      return canonical;
  }
}

// Clamped copy of a runner activity for the legacy `agent_turn_activity` event,
// which previously carried raw runner params: an unbounded tool-output chunk
// would otherwise sit in the recent-event buffer x200 and be returned by
// /api/status, /api/logs, and the WS greeting.
export function boundedRunnerActivity(
  activity: AgentRunnerActivity,
  runnerKind: string
): z.infer<typeof codingActivitySchema> {
  return normalizedActivity(activity, runnerKind);
}

/**
 * The agent's own answer vocabulary for one request, bounded like everything
 * else that crosses this boundary. The cap is generous against any real request
 * (an agent offers a handful of choices) and exists because the list arrives
 * from an operator-supplied binary.
 */
function answerablePermissionFields(
  requestId: string | undefined,
  options: ReadonlyArray<{ optionId: string; name?: string; kind?: string }> | undefined
): { requestId: string; options: Array<{ optionId: string; name?: string; kind?: string }> } | Record<string, never> {
  const parsedRequestId = z.string().min(1).max(MAX_PERMISSION_REQUEST_ID_LENGTH).safeParse(requestId);
  const parsedOptions = codingPermissionOptionsSchema.safeParse(options);
  if (!parsedRequestId.success || !parsedOptions.success) return {};
  return { requestId: parsedRequestId.data, options: parsedOptions.data };
}

/**
 * A clarifying-question batch, bounded like everything else that crosses this
 * boundary: text is clamped to its ceiling, ids are kept exact, and a batch that
 * still fails the schema (too many sets, a duplicate id, a set nobody could
 * answer) produces no event at all rather than a half-renderable one.
 */
function boundedQuestionSets(sets: readonly CanonicalQuestionSet[]): CanonicalQuestionSet[] | undefined {
  const clamped = sets.slice(0, MAX_QUESTION_SETS + 1).map((set) => ({
    setId: set.setId,
    ...(set.header ? { header: clampText(set.header, MAX_QUESTION_HEADER_LENGTH) } : {}),
    prompt: clampText(set.prompt, MAX_QUESTION_PROMPT_LENGTH),
    selection: set.selection,
    options: set.options.slice(0, MAX_QUESTION_OPTIONS + 1).map((option) => ({
      optionId: option.optionId,
      label: clampText(option.label, MAX_QUESTION_LABEL_LENGTH),
      ...(option.description ? { description: clampText(option.description, MAX_QUESTION_DESCRIPTION_LENGTH) } : {})
    })),
    discussion: set.discussion,
    ...(set.sensitive ? { sensitive: true } : {})
  }));
  const parsed = codingQuestionSetsSchema.safeParse(clamped);
  return parsed.success ? parsed.data : undefined;
}

/** The answer-route id, kept exact: a bound may refuse it, never reshape it. */
function answerableQuestionRequestId(requestId: string | undefined): { requestId: string } | Record<string, never> {
  const parsed = z.string().min(1).max(MAX_QUESTION_ID_LENGTH).safeParse(requestId);
  return parsed.success ? { requestId: parsed.data } : {};
}

function boundedQuestionAnswers(
  answers: readonly CanonicalQuestionAnswer[] | undefined
): { questionAnswers: CanonicalQuestionAnswer[] } | Record<string, never> {
  if (!answers) return {};
  const clamped = answers.slice(0, MAX_QUESTION_SETS).map((answer) => ({
    setId: answer.setId,
    selectedOptionIds: answer.selectedOptionIds.slice(0, MAX_QUESTION_OPTIONS),
    ...(answer.discussion ? { discussion: clampText(answer.discussion, MAX_QUESTION_DISCUSSION_LENGTH) } : {})
  }));
  const parsed = codingQuestionAnswersSchema.safeParse(clamped);
  return parsed.success ? { questionAnswers: parsed.data } : {};
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).slice(0, 50).map(([key, item]) => [clampText(key, 100), boundedValue(item)]);
  return Object.fromEntries(entries);
}

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return clampText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(boundedValue);
  const object = objectValue(value);
  if (object) return boundedRecord(object);
  return value;
}

function clampText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return value.slice(0, maxLength);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? clampText(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}
