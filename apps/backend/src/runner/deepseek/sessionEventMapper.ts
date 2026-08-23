import type { AgentRunnerActivity, AgentRunnerEvent, RunnerMetadata } from "../AgentRunner";
import { compactDisplayText, displayTextValue } from "../shared/displayText";
import { labelFromIdentifier } from "../shared/jsonValues";
import {
  assistantChunkDataSchema,
  assistantMessageDataSchema,
  requestContextDataSchema,
  requestHeaderDataSchema,
  todoWriteDataSchema,
  toolCallDataSchema,
  toolResultDataSchema,
  turnEndDataSchema,
  turnStartDataSchema,
  type DeepSeekSessionEvent,
  type DeepSeekTokenUsage
} from "./protocol";

/**
 * The DeepSeek session log, mapped into the canonical activity union.
 *
 * The runtime streams every durable fact of a session as a `session.event`
 * envelope (`turn/start`, `assistant/chunk`, `tool/call`, `todo/write`, …), and
 * this module is the only place that knows what those names mean. Above the
 * `AgentRunner` boundary the mapper in `protocol/coding` dispatches on
 * `canonical.kind` alone, so an event this module gives no canonical reading —
 * step boundaries, seed markers, the runtime's own request headers — produces no
 * `coding_*` event at all rather than a rendering nobody asked for.
 *
 * Nothing here throws on an unfamiliar shape. This is a merge-extensible log on
 * a developer-preview runtime: a plugin may add event types, and a mapper that
 * failed a turn over one would make every new `dsh` plugin a breaking change.
 * Unparseable data is skipped; unknown types are ignored.
 */

/** Per-turn state the mapper carries between events. */
export interface DeepSeekTurnState {
  /** The runtime's turn number, claimed from the first `turn/start` we see. */
  turnNumber?: number;
  /** The context window the active route advertised, from `request/context`. */
  modelContextWindowTokens?: number;
  /** Whether the restored child found this session's log — `request/header`. */
  resumedLog?: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cachedInputTokens: number;
}

export function createDeepSeekTurnState(): DeepSeekTurnState {
  return { inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cachedInputTokens: 0 };
}

/** How a turn ended, when this event ended it. */
export interface DeepSeekTurnCompletion {
  event: AgentRunnerEvent;
  /** The runtime's turn number the completion belongs to. */
  turnNumber?: number;
}

export interface DeepSeekMapContext {
  state: DeepSeekTurnState;
  runner: RunnerMetadata;
}

export interface DeepSeekMapResult {
  events: AgentRunnerEvent[];
  completion?: DeepSeekTurnCompletion;
}

export function mapDeepSeekSessionEvent(
  event: DeepSeekSessionEvent,
  context: DeepSeekMapContext
): DeepSeekMapResult {
  const runner = runnerMetadataFor(event, context);
  switch (event.type) {
    case "turn/start": {
      const data = turnStartDataSchema.safeParse(event.data);
      if (data.success) context.state.turnNumber ??= data.data.turn;
      return {
        events: [
          activityEvent({
            kind: "deepseek_turn_start",
            title: "Turn started",
            content: {},
            canonical: { kind: "turn_started" },
            runner
          })
        ]
      };
    }

    case "turn/end":
      return mapTurnEnd(event, context, runner);

    case "assistant/chunk":
      return mapAssistantChunk(event, context, runner);

    case "assistant/message": {
      // The assembled message is the one durable accounting source. The runtime
      // also records the raw usage StreamChunk that built it, so counting both
      // would double every request's tokens. The text itself already streamed as
      // chunks and is likewise not republished here.
      const data = assistantMessageDataSchema.safeParse(event.data);
      if (!data.success || !data.data.usage) return { events: [] };
      return { events: [usageEvent(data.data.usage, context, runner)] };
    }

    case "tool/call": {
      const data = toolCallDataSchema.safeParse(event.data);
      if (!data.success) return { events: [] };
      const description = compactDisplayText(data.data.arguments) ?? undefined;
      return {
        events: [
          activityEvent({
            kind: "deepseek_tool_call",
            title: labelFromIdentifier(data.data.name),
            ...(description ? { description } : {}),
            content: { name: data.data.name, callId: data.data.callId },
            canonical: { kind: "tool_started", toolId: data.data.callId },
            runner: { ...runner, nativeItemId: data.data.callId }
          })
        ]
      };
    }

    case "tool/result": {
      const data = toolResultDataSchema.safeParse(event.data);
      if (!data.success) return { events: [] };
      // The result's model-facing content can be large and is already the tool's
      // own output; only its display summary and any failure identity travel as
      // an activity, and the canonical mapper bounds what does.
      const description = displayTextValue(data.data.message)
        ?? (data.data.error?.code ? `Failed: ${data.data.error.code}` : undefined);
      const callId = data.data.message?.source?.callId
        ?? data.data.message?.content?.find((block) => block.toolCallId)?.toolCallId;
      return {
        events: [
          activityEvent({
            kind: "deepseek_tool_result",
            title: data.data.error ? "Tool failed" : "Tool completed",
            ...(description ? { description } : {}),
            content: {
              ...(callId ? { callId } : {}),
              ...(data.data.error ? { error: data.data.error } : {})
            },
            canonical: { kind: "tool_completed", ...(callId ? { toolId: callId } : {}) },
            runner: { ...runner, ...(callId ? { nativeItemId: callId } : {}) }
          })
        ]
      };
    }

    case "todo/write": {
      const data = todoWriteDataSchema.safeParse(event.data);
      if (!data.success) return { events: [] };
      const steps = data.data.todos.map((todo) => ({
        step: todo.content,
        status: todo.status ?? "pending"
      }));
      return {
        events: [
          activityEvent({
            kind: "deepseek_todo_write",
            title: "Plan updated",
            content: { count: steps.length },
            canonical: { kind: "plan_updated", steps },
            runner
          })
        ]
      };
    }

    case "request/context": {
      // Route metadata, logged only when the route or its capacity changes. The
      // advertised context window is the one thing here AgentRoom renders, and
      // it rides the next usage event rather than becoming an event of its own:
      // a window with no occupancy beside it is not a reading a client can use.
      const data = requestContextDataSchema.safeParse(event.data);
      if (data.success && data.data.contextWindow) {
        context.state.modelContextWindowTokens = data.data.contextWindow;
      }
      return { events: [] };
    }

    case "request/header": {
      // `resume` is the only fact on this wire that distinguishes a restored
      // conversation from a silent fresh start. Recorded, never rendered.
      const data = requestHeaderDataSchema.safeParse(event.data);
      // Only the log's *first* header answers this. `change` is a later request
      // with a different header and says nothing about whether the conversation
      // was found, so it must not be read as a fresh start.
      if (data.success && (data.data.reason === "initial" || data.data.reason === "resume")) {
        context.state.resumedLog ??= data.data.reason === "resume";
      }
      return { events: [] };
    }

    default:
      // `step/start`, `step/end`, `user/message` (AgentRoom already holds the
      // transcript), `session/end-seed`, and anything a plugin added: no
      // canonical reading, so no `coding_*` event.
      return { events: [] };
  }
}

function mapAssistantChunk(
  event: DeepSeekSessionEvent,
  context: DeepSeekMapContext,
  runner: RunnerMetadata
): DeepSeekMapResult {
  const data = assistantChunkDataSchema.safeParse(event.data);
  if (!data.success) return { events: [] };
  const chunk = data.data.chunk;

  if (chunk.type === "text-delta" && chunk.text) {
    // Assistant prose. `agent_update` is what the turn applier runs the artifact
    // parser over, so the in-band `<artifact>` channel works for this runner
    // without the adapter knowing the channel exists.
    return { events: [{ type: "agent_update", message: chunk.text, runner }] };
  }

  if (chunk.type === "reasoning-delta" && chunk.text) {
    return {
      events: [
        activityEvent({
          kind: "deepseek_reasoning",
          title: "Thinking",
          content: {},
          canonical: { kind: "reasoning", delta: chunk.text },
          runner
        })
      ]
    };
  }

  return { events: [] };
}

function mapTurnEnd(
  event: DeepSeekSessionEvent,
  context: DeepSeekMapContext,
  runner: RunnerMetadata
): DeepSeekMapResult {
  const data = turnEndDataSchema.safeParse(event.data);
  if (!data.success) return { events: [] };
  const kind = data.data.reason?.kind;
  const turnNumber = data.data.turn;

  // `completed` and `max-tokens` both produced output the operator can use; the
  // latter is reported rather than hidden, because a truncated answer that reads
  // as a clean one is the failure worth naming.
  if (kind === "completed") {
    return { events: [], completion: { event: { type: "run_succeeded" }, turnNumber } };
  }
  if (kind === "max-tokens") {
    return {
      events: [],
      completion: {
        event: { type: "run_succeeded", message: "DeepSeek Harness turn reached its output-token ceiling" },
        turnNumber
      }
    };
  }

  const error = kind === "error"
    ? compactDisplayText(data.data.reason?.error?.message) ?? "DeepSeek Harness turn failed"
    : kind === "aborted"
      ? "DeepSeek Harness turn was cancelled"
      : kind === "blocked"
        ? "DeepSeek Harness turn was blocked"
        : kind === "interrupted"
          ? "DeepSeek Harness turn was interrupted before it completed"
          : `DeepSeek Harness turn ended (${kind ?? "unknown reason"})`;
  return { events: [], completion: { event: { type: "run_failed", error }, turnNumber } };
}

/**
 * Cumulative turn totals plus the live occupancy of the latest request.
 *
 * `contextWindowUsedTokens` is deliberately this request's own footprint rather
 * than the running totals beside it: the cumulative figures re-count the cached
 * conversation on every tool round-trip, so using them would overstate occupancy
 * by roughly the number of requests in the turn.
 */
function usageEvent(
  usage: DeepSeekTokenUsage,
  context: DeepSeekMapContext,
  runner: RunnerMetadata
): AgentRunnerEvent {
  const state = context.state;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  state.inputTokens += inputTokens;
  state.outputTokens += outputTokens;
  state.cachedInputTokens += usage.cacheReadTokens ?? 0;
  state.reasoningOutputTokens += usage.reasoningTokens ?? 0;
  return {
    type: "token_usage_updated",
    runner,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    outputTokens: state.outputTokens,
    reasoningOutputTokens: state.reasoningOutputTokens,
    totalTokens: state.inputTokens + state.outputTokens,
    contextWindowUsedTokens: inputTokens + outputTokens,
    ...(state.modelContextWindowTokens
      ? { modelContextWindowTokens: state.modelContextWindowTokens }
      : {})
  };
}

function runnerMetadataFor(event: DeepSeekSessionEvent, context: DeepSeekMapContext): RunnerMetadata {
  const turnNumber = turnNumberOf(event) ?? context.state.turnNumber;
  return {
    ...context.runner,
    ...(turnNumber === undefined ? {} : { nativeTurnId: String(turnNumber) }),
    native: {
      ...(context.runner.native ?? {}),
      eventType: event.type,
      seq: event.seq
    }
  };
}

function turnNumberOf(event: DeepSeekSessionEvent): number | undefined {
  const data = event.data;
  if (!data || typeof data !== "object") return undefined;
  const turn = (data as { turn?: unknown }).turn;
  return typeof turn === "number" ? turn : undefined;
}

function activityEvent(activity: AgentRunnerActivity): AgentRunnerEvent {
  return { type: "agent_activity", activity };
}
