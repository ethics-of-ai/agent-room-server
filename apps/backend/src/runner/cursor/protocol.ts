import { z } from "zod";

/**
 * The wire between the Cursor SDK adapter and the host child it spawns.
 *
 * The host is the one process that imports `@cursor/sdk`
 * (docs/engineering/CURSOR_SDK_RUNNER.md, "a process boundary"): the SDK runs
 * the agent loop inline in the process that imports it, so running it in a
 * dedicated child is what keeps the `AUTH_TOKEN` scrub, the `commandAudit` row,
 * and the cancel ladder literal. Backend and host speak newline-delimited
 * JSON-RPC 2.0 over the child's stdio through the shared
 * `runner/shared/JsonRpcLineClient.ts`, the same framing Codex and DeepSeek use.
 *
 * These schemas are imported by **both** sides and validated on receipt.
 * Validation is not the trust boundary — that is the scrubbed child environment
 * — it is what stops a malformed frame reaching the mapper as an unchecked
 * shape. Everything is permissive about unknown fields and strict about the
 * ones AgentRoom reads: the SDK is a 1.0.x developer preview with no version
 * negotiation, so a new field must not fail a turn.
 */

/** A model selection in the SDK's own `{ id, params }` shape. */
export const modelSelectionSchema = z.object({
  id: z.string().min(1),
  params: z.array(z.object({ id: z.string().min(1), value: z.string() })).optional()
});

export type CursorModelSelection = z.infer<typeof modelSelectionSchema>;

/** One inlined image, the SDK's `{ data, mimeType }` local-image source. */
export const hostImageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1)
});

// Backend → host requests.

export const initializeParamsSchema = z.object({
  /** Explicit key; omitted so the SDK resolves `CURSOR_API_KEY` else the stored web sign-in. */
  apiKey: z.string().min(1).optional(),
  /** The pinned SQLite store root under `$AGENTROOM_HOME/state`, never `~/.cursor/projects`. */
  stateRoot: z.string().min(1),
  backendUrl: z.string().min(1).optional()
});

export const initializeResultSchema = z.object({
  sdkVersion: z.string()
});

export const agentStartParamsSchema = z.object({
  cwd: z.string().min(1),
  /** Present to resume a persisted agent from a fresh host (fact 1). */
  agentId: z.string().min(1).optional(),
  model: modelSelectionSchema,
  settingSources: z.array(z.string()),
  sandbox: z.boolean(),
  autoReview: z.boolean(),
  disallowedTools: z.array(z.string()),
  /** When true the host registers the one clarifying-question custom tool. */
  questionTool: z.boolean()
});

export const agentStartResultSchema = z.object({
  agentId: z.string().min(1),
  resumed: z.boolean()
});

export const agentSendParamsSchema = z.object({
  text: z.string(),
  images: z.array(hostImageSchema).optional(),
  /** A per-turn model override; the SDK's `send({ model })`. */
  model: modelSelectionSchema.optional(),
  mode: z.enum(["agent", "plan"]).optional(),
  /** Recover a persisted agent whose prior host died with a run still active. */
  force: z.boolean().optional()
});

export const agentSendResultSchema = z.object({
  runId: z.string().min(1)
});

export const runCancelParamsSchema = z.object({
  runId: z.string().min(1)
});

export const modelsListResultSchema = z.object({
  /** Raw `Cursor.models.list()` entries; the backend's capabilities mapper reads them. */
  models: z.array(z.unknown())
});

// Host → backend notifications.

/** One `SDKMessage`, passed through with unknown fields preserved. */
export const sdkMessageSchema = z.object({ type: z.string().min(1) }).passthrough();

export const runMessageNotificationSchema = z.object({
  runId: z.string().min(1),
  message: sdkMessageSchema
});

/** Only `shell-output-delta` is forwarded; every other delta the host drops. */
export const runDeltaNotificationSchema = z.object({
  runId: z.string().min(1),
  update: z.object({ type: z.string().min(1) }).passthrough()
});

export const runResultNotificationSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["finished", "error", "cancelled"]),
  result: z.string().optional(),
  error: z.object({ message: z.string(), code: z.string().optional() }).partial({ code: true }).optional(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      cacheReadTokens: z.number().nonnegative().optional(),
      cacheWriteTokens: z.number().nonnegative().optional(),
      reasoningTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional()
    })
    .optional(),
  durationMs: z.number().nonnegative().optional()
});

// Host → backend request: the custom question tool's callback, relayed.

export const questionAskParamsSchema = z.object({
  /** The raw custom-tool arguments the model produced; the backend mints ids. */
  input: z.record(z.string(), z.unknown())
});

export const questionAskResultSchema = z.object({
  /** The model-facing text the tool returns; labels and invited free text, never an id. */
  result: z.string()
});

const jsonRpcIdSchema = z.union([z.string(), z.number()]);

/** Backend request or response frame accepted by the Cursor host's stdin. */
export const cursorHostIncomingFrameSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: jsonRpcIdSchema,
    method: z.string().min(1).optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional()
  })
  .passthrough()
  .refine((frame) => frame.method !== undefined || frame.result !== undefined || frame.error !== undefined);

export type CursorHostIncomingFrame = z.infer<typeof cursorHostIncomingFrameSchema>;

export type CursorHostRequestMethod =
  | "initialize"
  | "agent/start"
  | "agent/send"
  | "run/cancel"
  | "models/list"
  | "shutdown";

/** The one request the host makes of the backend. */
export const HOST_QUESTION_METHOD = "question/ask";
