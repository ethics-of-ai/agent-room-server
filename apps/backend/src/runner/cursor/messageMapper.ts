import type { AgentRunnerActivity, AgentRunnerEvent, CanonicalPlanStep, RunnerMetadata } from "../AgentRunner";
import { arrayValue, nonnegativeIntegerValue, objectValue, stringValue } from "../shared/jsonValues";
import { compactDisplayText, displayTextValue } from "../shared/displayText";
import { CURSOR_QUESTION_TOOL_NAME } from "./questions";
import { decodeCursorShellDelta } from "./delta";

/**
 * The Cursor SDK stream, mapped into the canonical activity union.
 *
 * The host forwards each `SDKMessage` from `run.stream()` as a `run/message`
 * notification and the one delta worth forwarding (`shell-output-delta`) as a
 * `run/delta`; this module is the only place that reads what those mean. Above
 * the `AgentRunner` boundary the mapper in `protocol/coding` dispatches on
 * `canonical.kind` alone, so a message this module gives no canonical reading —
 * `status`, `request`, `task`, `user` — produces no `coding_*` event at all.
 *
 * Nothing here throws on an unfamiliar shape: the SDK is a 1.0.x preview with no
 * version negotiation, and a message it grows a field on must not fail a turn.
 *
 * Two settlement facts live in the adapter, not here: `session_started` (the
 * agent id the host returns) and `turn_started` (the run id `agent/send`
 * returns) are emitted there because the stream does not reliably carry a
 * `system`/`init` message, and `run/result` is what settles a turn — a `status`
 * message alone never does.
 */

/** Per-run accounting the mapper carries between messages. */
export interface CursorTurnState {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

export function createCursorTurnState(): CursorTurnState {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
}

/**
 * True for the one `tool_call` the mapper must not render: the clarifying
 * question custom tool. Its canonical `question_requested` / `question_resolved`
 * pair is emitted from the `question/ask` request and its settlement instead, so
 * rendering it here too would double it as a generic tool call (fact 3).
 */
export function isCursorQuestionToolCall(object: Record<string, unknown>): boolean {
  if (stringValue(object.name) !== "mcp") return false;
  const args = objectValue(object.args);
  return (
    stringValue(args?.providerIdentifier) === "custom-user-tools" &&
    stringValue(args?.toolName) === CURSOR_QUESTION_TOOL_NAME
  );
}

export function mapCursorMessage(
  message: unknown,
  ctx: { runId: string; base: RunnerMetadata; state: CursorTurnState }
): AgentRunnerEvent[] {
  const object = objectValue(message);
  if (!object) return [];
  const type = stringValue(object.type);
  const runner: RunnerMetadata = { ...ctx.base, nativeTurnId: ctx.runId };

  switch (type) {
    case "assistant":
      return assistantUpdates(object, runner);
    case "thinking": {
      const text = stringValue(object.text);
      return text
        ? [activity({
            kind: "cursor_reasoning",
            title: "Reasoning update",
            content: { delta: text },
            canonical: { kind: "reasoning", delta: text },
            runner
          })]
        : [];
    }
    case "tool_call":
      return toolCallActivities(object, runner);
    case "usage": {
      const usage = objectValue(object.usage);
      return usage ? [usageEvent(usage, ctx.state, runner)] : [];
    }
    default:
      // `status` (settled by run/result), `request` (undocumented, fact 3),
      // `task` (a sub-agent, no canonical home), `user` (AgentRoom holds the
      // transcript), and `system` (session_started is the adapter's): no
      // canonical reading, so no coding_* event.
      return [];
  }
}

/** The one forwarded delta: streamed shell stdout, mapped to `tool_output`. */
export function mapCursorDelta(
  update: unknown,
  ctx: { base: RunnerMetadata }
): AgentRunnerEvent[] {
  const decoded = decodeCursorShellDelta(update);
  if (!decoded) return [];
  const delta = compactDisplayText(decoded.data);
  if (!delta) return [];
  return [activity({
    kind: "cursor_tool_output",
    title: "Tool output",
    content: {
      ...(decoded.callId ? { callId: decoded.callId } : {}),
      ...(decoded.stream ? { stream: decoded.stream } : {}),
      delta
    },
    canonical: { kind: "tool_output", ...(decoded.callId ? { toolId: decoded.callId } : {}), delta },
    runner: decoded.callId ? { ...ctx.base, nativeItemId: decoded.callId } : ctx.base
  })];
}

function assistantUpdates(object: Record<string, unknown>, runner: RunnerMetadata): AgentRunnerEvent[] {
  // Only text blocks. Tool use rides the discrete `tool_call` messages, which
  // carry status and a call id; mapping tool_use here too would double them.
  const content = arrayValue(objectValue(object.message)?.content);
  const events: AgentRunnerEvent[] = [];
  for (const block of content) {
    const blockObject = objectValue(block);
    if (stringValue(blockObject?.type) !== "text") continue;
    const text = stringValue(blockObject?.text);
    if (text) events.push({ type: "agent_update", message: text, runner });
  }
  return events;
}

function toolCallActivities(object: Record<string, unknown>, runner: RunnerMetadata): AgentRunnerEvent[] {
  if (isCursorQuestionToolCall(object)) return [];
  const name = stringValue(object.name) ?? "tool";
  const callId = stringValue(object.call_id);
  const status = stringValue(object.status);
  const toolRunner = callId ? { ...runner, nativeItemId: callId } : runner;

  if (status === "running") {
    const planSteps = planStepsFrom(name, object.args);
    const description = compactDisplayText(displayTextValue(object.args));
    const started = activity({
      kind: "cursor_tool_started",
      title: labelForTool(name),
      ...(description ? { description } : {}),
      content: { name, ...(callId ? { callId } : {}), ...(objectValue(object.args) ? { args: objectValue(object.args) } : {}) },
      canonical: { kind: "tool_started", ...(callId ? { toolId: callId } : {}) },
      runner: toolRunner
    });
    // updateTodos / createPlan also surface the plan itself.
    return planSteps
      ? [started, activity({
          kind: "cursor_plan_updated",
          title: "Plan updated",
          content: { count: planSteps.length },
          canonical: { kind: "plan_updated", steps: planSteps },
          runner: toolRunner
        })]
      : [started];
  }

  if (status === "completed" || status === "error") {
    const description = compactDisplayText(displayTextValue(object.result));
    const truncated = objectValue(object.truncated);
    return [activity({
      kind: "cursor_tool_completed",
      title: status === "error" ? "Tool failed" : "Tool completed",
      ...(description ? { description } : {}),
      content: {
        ...(callId ? { callId } : {}),
        ...(status === "error" ? { isError: true } : {}),
        ...(truncated ? { truncated } : {})
      },
      canonical: { kind: "tool_completed", ...(callId ? { toolId: callId } : {}) },
      runner: toolRunner
    })];
  }

  return [];
}

function planStepsFrom(name: string, args: unknown): CanonicalPlanStep[] | undefined {
  if (name !== "updateTodos" && name !== "createPlan") return undefined;
  const todos = arrayValue(objectValue(args)?.todos ?? objectValue(args)?.steps);
  if (todos.length === 0) return undefined;
  return todos.flatMap((todo) => {
    const object = objectValue(todo);
    const step = stringValue(object?.content) ?? stringValue(object?.step) ?? stringValue(todo);
    return step ? [{ step, status: stringValue(object?.status) ?? "pending" }] : [];
  });
}

function usageEvent(
  usage: Record<string, unknown>,
  state: CursorTurnState,
  runner: RunnerMetadata
): AgentRunnerEvent {
  const inputTokens = nonnegativeIntegerValue(usage.inputTokens) ?? 0;
  const outputTokens = nonnegativeIntegerValue(usage.outputTokens) ?? 0;
  state.inputTokens += inputTokens;
  state.outputTokens += outputTokens;
  state.cachedInputTokens += nonnegativeIntegerValue(usage.cacheReadTokens) ?? 0;
  state.reasoningOutputTokens += nonnegativeIntegerValue(usage.reasoningTokens) ?? 0;
  return {
    type: "token_usage_updated",
    runner,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    outputTokens: state.outputTokens,
    reasoningOutputTokens: state.reasoningOutputTokens,
    // No context-window figure rides this wire, so occupancy is this request's
    // own footprint — the same reading the other adapters report.
    contextWindowUsedTokens: inputTokens + outputTokens,
    totalTokens: state.inputTokens + state.outputTokens
  };
}

function labelForTool(name: string): string {
  switch (name) {
    case "shell":
      return "Run command";
    case "read":
    case "readLints":
      return "Read file";
    case "edit":
    case "write":
    case "delete":
      return "Edit files";
    case "grep":
    case "glob":
    case "ls":
    case "semSearch":
      return "Search files";
    case "task":
      return "Run subagent";
    case "updateTodos":
    case "createPlan":
      return "Update plan";
    case "mcp":
      return "Call MCP tool";
    case "generateImage":
      return "Generate image";
    default:
      return "Call tool";
  }
}

function activity(activity: AgentRunnerActivity): AgentRunnerEvent {
  return { type: "agent_activity", activity };
}
