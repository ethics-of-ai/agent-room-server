import { z } from "zod";

/**
 * The DeepSeek Harness SDK runtime protocol, as much of it as AgentRoom
 * consumes.
 *
 * The runtime speaks newline-delimited JSON-RPC 2.0 over stdio
 * (`@deepseek-ai/dsh-sdk-jsonrpc-server`, wire types in
 * `@deepseek-ai/dsh-sdk-protocol`). AgentRoom takes **no dependency** on those
 * packages: the runtime is an operator-installed executable like `codex`, so the
 * protocol is spoken directly and every consumed message is zod-validated on
 * receipt. Validation is not trust — that is admission and the child
 * environment — it is what stops a malformed frame reaching the mapper as an
 * unchecked shape.
 *
 * Two properties of this protocol shape the adapter and are not worked around:
 * there is no prompt-cancel method (so cancelling kills the child and the next
 * turn restores the conversation) and no server-to-client requests (so there is
 * no interactive permission channel to expose). The runtime's own README
 * documents both.
 *
 * Everything here is deliberately permissive about *unknown* fields and strict
 * about the ones AgentRoom reads: this is a developer preview whose protocol
 * carries no version negotiation, so a new field must not fail a turn.
 */

/** Wire-stable server identity. A different name is a different program. */
export const DEEPSEEK_SDK_SERVER_NAME = "deepseek-harness-sdk-runtime";

export const initializeResultSchema = z.object({
  serverInfo: z.object({
    name: z.string(),
    version: z.string().optional()
  })
});

export const sessionPromptResultSchema = z.object({
  messageId: z.string().min(1)
});

/**
 * One session-log event envelope. `data` stays `unknown` here and is narrowed
 * per event type by the schemas below, because the log is merge-extensible: a
 * plugin can add event types, and a reader that refused the whole envelope for
 * an unrecognized `data` shape would fail turns on a runtime that merely has
 * more plugins than this one was written against.
 */
export const sessionEventSchema = z.object({
  type: z.string().min(1),
  seq: z.number(),
  time: z.number().optional(),
  data: z.unknown(),
  ignorable: z.literal(true).optional()
});

export type DeepSeekSessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEventNotificationSchema = z.object({
  sessionId: z.string().min(1),
  event: sessionEventSchema
});

export const sessionStatusNotificationSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(["idle", "running"])
});

export const subagentStartedNotificationSchema = z.object({
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1)
});

/** The `data` payloads of the log events AgentRoom gives a canonical reading. */

const tokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional()
});

export type DeepSeekTokenUsage = z.infer<typeof tokenUsageSchema>;

export const turnStartDataSchema = z.object({ turn: z.number() });

/**
 * `turn/end` carries why the turn ended. The union is merge-extensible on the
 * runtime side, so `kind` is read as a string and an unfamiliar value settles
 * the turn rather than hanging it — a turn that never settles is a worse
 * failure than one settled under a name we did not recognize.
 */
export const turnEndDataSchema = z.object({
  turn: z.number(),
  reason: z
    .object({
      kind: z.string().optional(),
      error: z.object({ message: z.string().optional(), code: z.string().optional() }).partial().optional(),
      reason: z.object({ kind: z.string().optional() }).partial().optional()
    })
    .optional()
});

/**
 * One streamed chunk of a model response.
 *
 * Deliberately one open shape rather than a discriminated union: block
 * boundaries, tool-call argument deltas, and the finish marker carry no
 * canonical reading of their own — the assembled `tool/call` and `turn/end`
 * events are what AgentRoom maps — so an unrecognized `type` must pass through
 * and be ignored rather than fail the envelope it arrived in.
 */
export const streamChunkSchema = z
  .object({
    type: z.string(),
    /** Present on `text-delta` and `reasoning-delta`. */
    text: z.string().optional(),
    /** Present on `usage`. */
    usage: tokenUsageSchema.optional()
  })
  .passthrough();

export const assistantChunkDataSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  chunk: streamChunkSchema
});

export const assistantMessageDataSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  usage: tokenUsageSchema.optional()
});

export const toolCallDataSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  callId: z.string().min(1),
  name: z.string().min(1),
  /** The raw arguments JSON exactly as the model produced it (unparsed). */
  arguments: z.string().optional()
});

export const toolResultDataSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  message: z
    .object({
      source: z
        .object({
          callId: z.string().min(1).optional()
        })
        .passthrough()
        .optional(),
      content: z
        .array(
          z
            .object({
              toolCallId: z.string().min(1).optional()
            })
            .passthrough()
        )
        .optional()
    })
    .passthrough()
    .optional(),
  error: z.object({ name: z.string().optional(), code: z.string().optional() }).partial().optional()
});

export const todoWriteDataSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.string().optional()
    })
  )
});

export const requestContextDataSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  /** Maximum combined request and response context, when the route advertises one. */
  contextWindow: z.number().positive().optional()
});

/**
 * `request/header` records why a request header was appended, and `resume` is
 * the one fact on this wire that says a restored child actually found the
 * session's log: `'initial'` is a new conversation, `'resume'` is "a loop
 * instance's first request over a log that already has header events". The
 * adapter reads it to tell a real restore from a silent fresh start.
 */
export const requestHeaderDataSchema = z.object({
  reason: z.enum(["initial", "resume", "change"]).optional()
});
