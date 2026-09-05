import { z } from "zod";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_OPTION_KIND_LENGTH,
  MAX_PERMISSION_OPTION_NAME_LENGTH,
  MAX_PERMISSION_OPTIONS,
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

export const codingAgentEventTypeSchema = z.enum([
  "coding_session_started",
  "coding_session_restored",
  "coding_turn_started",
  "coding_token_usage_updated",
  "coding_assistant_message_delta",
  "coding_plan_updated",
  "coding_diff_updated",
  "coding_artifact_started",
  "coding_artifact_delta",
  "coding_artifact_completed",
  "coding_tool_activity_started",
  "coding_tool_activity_updated",
  "coding_tool_activity_completed",
  "coding_permission_requested",
  "coding_permission_resolved",
  "coding_question_requested",
  "coding_question_resolved",
  "coding_context_compaction_started",
  "coding_context_compaction_completed",
  "coding_turn_completed",
  "coding_turn_failed",
  "coding_turn_cancelled"
]);

export type CodingAgentEventType = z.infer<typeof codingAgentEventTypeSchema>;

/**
 * The version of the `coding_*` event contract this backend speaks, advertised
 * by `GET /api/config` as `codingEventContractVersion`. It is distinct from the
 * per-payload `version: 1` envelope field, which says how a single payload is
 * shaped; this says which *fields* the payloads are guaranteed to carry.
 *
 * 2 is the first version carrying the canonical `runner` metadata envelope and
 * the canonical activity payload. A version-2 backend still dual-emits the
 * legacy `codex`/`claudeCode` blocks so an independently upgraded client can
 * meet an older or newer peer; those blocks may only be retired once the
 * advertised floor moves past 2.
 */
export const CODING_EVENT_CONTRACT_VERSION = 2;

export const codingCodexMetadataSchema = z.object({
  method: z.string().optional(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  approvalPolicy: z.string().optional(),
  sandbox: z.unknown().optional()
});

export const codingClaudeCodeMetadataSchema = z.object({
  sessionId: z.string().optional(),
  messageUuid: z.string().optional(),
  parentToolUseId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  permissionMode: z.string().optional()
});

/**
 * The canonical correlation and display metadata every `coding_*` payload
 * carries. A client correlates and renders from these fields alone; `native`
 * holds the bounded per-runner extras that have no canonical home, and is
 * dropped whole (with `nativeTruncated`) rather than trimmed when it exceeds
 * its limits — a half-blob would read as complete.
 *
 * `posture` is a runner-supplied label/value pair, deliberately not a universal
 * permission enum: flattening a Codex approval policy and a Claude Code
 * permission mode into one field is the payload mistake in the place it would
 * do real damage.
 */
export const codingRunnerMetadataSchema = z.object({
  nativeSessionId: z.string().optional(),
  nativeTurnId: z.string().optional(),
  nativeItemId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  posture: z.object({ label: z.string(), value: z.string() }).optional(),
  sandbox: z.unknown().optional(),
  native: z.record(z.string(), z.unknown()).optional(),
  nativeTruncated: z.boolean().optional()
});

const baseCodingPayloadSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  // A label, not an admission decision: the session pinned a validated runner
  // kind at creation, and the mapper no longer branches on this value. Keeping
  // it an open string is what lets a third adapter's events flow through the
  // core mapper unchanged; `agentRunnerKindSchema` remains the admission gate.
  runnerKind: z.string().min(1).max(64),
  runner: codingRunnerMetadataSchema.optional(),
  // Legacy per-runner blocks. Emitted only by the compatibility shim in
  // `legacyMetadata.ts` while the advertised contract floor is below 2.
  codex: codingCodexMetadataSchema.optional(),
  claudeCode: codingClaudeCodeMetadataSchema.optional()
});

export const codingPlanStepSchema = z.object({
  step: z.string(),
  status: z.string()
});

export const codingDiffFileSchema = z.object({
  path: z.string(),
  // The pre-rename path when the runner's diff reports one (a Git-status
  // rename entry, or a unified diff's `rename from` header). Additive and
  // optional; a copy keeps its source on disk and never carries it.
  oldPath: z.string().optional(),
  status: z.string(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional()
});

/**
 * One option the agent offered for a permission request.
 *
 * A client renders these and may answer with one of their ids and nothing else:
 * `POST /api/agent-sessions/:id/permissions/:requestId` refuses an id the agent
 * did not supply, so the option list is the whole vocabulary of an answer.
 * `kind` is the agent's own classification (`allow_once`, `reject_once`, …) and
 * stays an open string — a client renders an unfamiliar one plainly rather than
 * dropping the option, which would hide the only answer the agent accepts.
 */
export const codingPermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(MAX_PERMISSION_OPTION_ID_LENGTH),
  name: z.string().max(MAX_PERMISSION_OPTION_NAME_LENGTH).optional(),
  kind: z.string().max(MAX_PERMISSION_OPTION_KIND_LENGTH).optional()
});

export const codingPermissionOptionsSchema = z
  .array(codingPermissionOptionSchema)
  .min(1)
  .max(MAX_PERMISSION_OPTIONS)
  .superRefine((options, context) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      if (seen.has(option.optionId)) {
        context.addIssue({
          code: "custom",
          message: "permission option ids must be unique",
          path: [index, "optionId"]
        });
      }
      seen.add(option.optionId);
    });
  });

/**
 * One clarifying-question set: a prompt, the options the agent offered, how
 * many may be chosen, and whether free text is accepted beside or instead of a
 * choice. Every id is AgentRoom-minted; a client answers with these ids and
 * nothing else — `POST /api/agent-sessions/:id/questions/:requestId` refuses a
 * set or option the agent did not offer. `selection` and `discussion` are
 * closed here because the backend mints the batch; a client still treats them
 * as open strings and degrades an unknown value to single-select / optional.
 */
export const codingQuestionOptionSchema = z.object({
  optionId: z.string().min(1).max(MAX_QUESTION_ID_LENGTH),
  label: z.string().min(1).max(MAX_QUESTION_LABEL_LENGTH),
  description: z.string().max(MAX_QUESTION_DESCRIPTION_LENGTH).optional()
});

export const codingQuestionSetSchema = z
  .object({
    setId: z.string().min(1).max(MAX_QUESTION_ID_LENGTH),
    header: z.string().max(MAX_QUESTION_HEADER_LENGTH).optional(),
    prompt: z.string().min(1).max(MAX_QUESTION_PROMPT_LENGTH),
    selection: z.enum(["single", "multiple"]),
    options: z.array(codingQuestionOptionSchema).max(MAX_QUESTION_OPTIONS),
    discussion: z.enum(["none", "optional", "required"]),
    sensitive: z.boolean().optional()
  })
  .superRefine((set, context) => {
    if (set.options.length === 0 && set.discussion !== "required") {
      context.addIssue({
        code: "custom",
        message: "a question set with no options must require discussion",
        path: ["options"]
      });
    }
    const seen = new Set<string>();
    set.options.forEach((option, index) => {
      if (seen.has(option.optionId)) {
        context.addIssue({ code: "custom", message: "question option ids must be unique", path: ["options", index, "optionId"] });
      }
      seen.add(option.optionId);
    });
  });

export const codingQuestionSetsSchema = z
  .array(codingQuestionSetSchema)
  .min(1)
  .max(MAX_QUESTION_SETS)
  .superRefine((sets, context) => {
    const seen = new Set<string>();
    sets.forEach((set, index) => {
      if (seen.has(set.setId)) {
        context.addIssue({ code: "custom", message: "question set ids must be unique", path: [index, "setId"] });
      }
      seen.add(set.setId);
    });
  });

export const codingQuestionAnswerSchema = z.object({
  setId: z.string().min(1).max(MAX_QUESTION_ID_LENGTH),
  selectedOptionIds: z.array(z.string().min(1).max(MAX_QUESTION_ID_LENGTH)).max(MAX_QUESTION_OPTIONS),
  discussion: z.string().max(MAX_QUESTION_DISCUSSION_LENGTH).optional()
});

export const codingQuestionAnswersSchema = z.array(codingQuestionAnswerSchema).min(1).max(MAX_QUESTION_SETS);

/**
 * What a completed context compaction reports, shared by the canonical
 * activity and the wire payload so the two cannot drift.
 *
 * The compaction's summary is not here and never will be: it is the model's
 * own account of the whole conversation, and it stops at the adapter. What
 * crosses is a trigger word and two integers.
 */
const codingContextCompactionFields = {
  trigger: z.enum(["auto", "manual"]).optional(),
  preTokens: z.number().int().nonnegative().optional(),
  postTokens: z.number().int().nonnegative().optional(),
  failed: z.boolean().optional()
};

/**
 * The runner-agnostic reading of one activity, produced by the adapter. A
 * client decides what an activity *is* from `kind` here — never from the
 * activity's native `kind` string, which stays beside it as display and
 * diagnostic detail.
 */
export const codingCanonicalActivitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_started") }),
  z.object({ kind: z.literal("turn_started") }),
  z.object({
    kind: z.literal("plan_updated"),
    explanation: z.string().optional(),
    steps: z.array(codingPlanStepSchema)
  }),
  z.object({
    kind: z.literal("diff_updated"),
    summary: z.string().optional(),
    files: z.array(codingDiffFileSchema),
    truncated: z.boolean().optional()
  }),
  z.object({ kind: z.literal("reasoning"), delta: z.string().optional() }),
  z.object({ kind: z.literal("tool_started"), toolId: z.string().optional() }),
  z.object({ kind: z.literal("tool_output"), toolId: z.string().optional(), delta: z.string().optional() }),
  z.object({ kind: z.literal("tool_completed"), toolId: z.string().optional() }),
  z.object({
    kind: z.literal("permission_requested"),
    requestId: z.string().max(MAX_PERMISSION_REQUEST_ID_LENGTH).optional(),
    options: codingPermissionOptionsSchema.optional(),
    request: z.record(z.string(), z.unknown())
  }),
  z.object({
    kind: z.literal("permission_resolved"),
    requestId: z.string().max(MAX_PERMISSION_REQUEST_ID_LENGTH).optional(),
    status: z.string().optional(),
    optionId: z.string().max(MAX_PERMISSION_OPTION_ID_LENGTH).optional(),
    decidedBy: z.string().optional()
  }),
  z.object({
    kind: z.literal("question_requested"),
    requestId: z.string().max(MAX_QUESTION_ID_LENGTH).optional(),
    questionSets: codingQuestionSetsSchema
  }),
  z.object({
    kind: z.literal("question_resolved"),
    requestId: z.string().max(MAX_QUESTION_ID_LENGTH).optional(),
    status: z.string().optional(),
    decidedBy: z.string().optional(),
    questionAnswers: codingQuestionAnswersSchema.optional()
  }),
  z.object({ kind: z.literal("context_compaction_started") }),
  // Every field is optional because the runners report different amounts, and
  // a compaction with no counts is still worth showing. `trigger` is closed
  // here because only one runner reports it and it reports exactly these two.
  z.object({
    kind: z.literal("context_compaction_completed"),
    ...codingContextCompactionFields
  })
]);

export const codingActivitySchema = z.object({
  /** The adapter's own name for the activity. Display and diagnostics only. */
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  content: z.record(z.string(), z.unknown()),
  canonical: codingCanonicalActivitySchema.optional(),
  runner: codingRunnerMetadataSchema.optional(),
  codex: codingCodexMetadataSchema.optional(),
  claudeCode: codingClaudeCodeMetadataSchema.optional()
});

// Artifacts are model-authored sketches streamed in-band and rendered live in
// the client. The first slice supports 2D vector kinds only; richer/3D kinds
// are intentionally excluded.
export const codingArtifactKindSchema = z.enum(["svg", "mermaid"]);

export const codingAgentEventPayloadSchema = z.discriminatedUnion("type", [
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_session_started")
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_session_restored")
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_turn_started"),
    turnId: z.string().min(1)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_token_usage_updated"),
    turnId: z.string().min(1),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    contextWindowUsedTokens: z.number().int().nonnegative().optional(),
    modelContextWindowTokens: z.number().int().positive().optional(),
    // A positive value replaces the runner-owned threshold; null explicitly
    // clears one it reported earlier. Omission carries no new knowledge.
    contextCompactionThresholdTokens: z.number().int().positive().nullable().optional()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_assistant_message_delta"),
    turnId: z.string().min(1),
    delta: z.string().min(1)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_plan_updated"),
    turnId: z.string().min(1),
    explanation: z.string().optional(),
    plan: z.array(codingPlanStepSchema)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_diff_updated"),
    turnId: z.string().min(1),
    summary: z.string().optional(),
    files: z.array(codingDiffFileSchema),
    truncated: z.boolean().optional()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_artifact_started"),
    turnId: z.string().min(1),
    artifactId: z.string().min(1),
    kind: codingArtifactKindSchema,
    title: z.string().min(1).optional()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_artifact_delta"),
    turnId: z.string().min(1),
    artifactId: z.string().min(1),
    delta: z.string().min(1)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_artifact_completed"),
    turnId: z.string().min(1),
    artifactId: z.string().min(1),
    bytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_tool_activity_started"),
    turnId: z.string().min(1),
    activity: codingActivitySchema
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_tool_activity_updated"),
    turnId: z.string().min(1),
    delta: z.string().optional(),
    activity: codingActivitySchema
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_tool_activity_completed"),
    turnId: z.string().min(1),
    activity: codingActivitySchema
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_permission_requested"),
    turnId: z.string().min(1),
    // Additive since the interactive-approval phase: the id an answer addresses
    // and the options an answer may name. A runner that answers from its own
    // stored policy alone carries neither, and a client renders the request as
    // the transcript entry it always was.
    requestId: z.string().max(MAX_PERMISSION_REQUEST_ID_LENGTH).optional(),
    options: codingPermissionOptionsSchema.optional(),
    request: z.record(z.string(), z.unknown())
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_permission_resolved"),
    turnId: z.string().min(1),
    requestId: z.string().max(MAX_PERMISSION_REQUEST_ID_LENGTH).optional(),
    status: z.string().optional(),
    optionId: z.string().max(MAX_PERMISSION_OPTION_ID_LENGTH).optional(),
    /**
     * `human`, `policy`, or `timeout` — who decided. An open string on the wire
     * like every other vocabulary here, and the whole point of the resolved
     * event: "allowed" reads very differently depending on who allowed it.
     */
    decidedBy: z.string().optional()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_question_requested"),
    turnId: z.string().min(1),
    // The id an answer addresses, present only while the backend holds the
    // batch open. A batch announced without it is a record a client renders
    // but cannot answer — the same rule as the permission request's fields.
    requestId: z.string().max(MAX_QUESTION_ID_LENGTH).optional(),
    questionSets: codingQuestionSetsSchema
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_question_resolved"),
    turnId: z.string().min(1),
    requestId: z.string().max(MAX_QUESTION_ID_LENGTH).optional(),
    /** `answered`, `timeout`, or `cancelled`; an open string on the wire. */
    status: z.string().optional(),
    /** `human` or `timeout` — who decided; absent when nobody did. */
    decidedBy: z.string().optional(),
    /** What was chosen per answered set. A sensitive set's text is never here. */
    questionAnswers: codingQuestionAnswersSchema.optional()
  }),
  // Additive under contract version 2: the event `type` and the canonical
  // `kind` are open vocabularies a client ignores when it does not recognize
  // them, so an older client skips both of these rather than failing a decode.
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_context_compaction_started"),
    turnId: z.string().min(1)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_context_compaction_completed"),
    turnId: z.string().min(1),
    ...codingContextCompactionFields
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_turn_completed"),
    turnId: z.string().min(1)
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_turn_failed"),
    turnId: z.string().min(1),
    error: z.string()
  }),
  baseCodingPayloadSchema.extend({
    type: z.literal("coding_turn_cancelled"),
    turnId: z.string().min(1)
  })
]);

export type CodingAgentEventPayload = z.infer<typeof codingAgentEventPayloadSchema>;
export type CodingRunnerMetadata = z.infer<typeof codingRunnerMetadataSchema>;
export type CodingCanonicalActivity = z.infer<typeof codingCanonicalActivitySchema>;
export type CodingCodexMetadata = z.infer<typeof codingCodexMetadataSchema>;
export type CodingClaudeCodeMetadata = z.infer<typeof codingClaudeCodeMetadataSchema>;
export type CodingArtifactKind = z.infer<typeof codingArtifactKindSchema>;

export interface CodingAgentEventCandidate {
  type: CodingAgentEventType;
  payload: CodingAgentEventPayload;
}
