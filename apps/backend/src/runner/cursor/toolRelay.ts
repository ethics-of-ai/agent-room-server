import { randomUUID } from "node:crypto";
import { unboundAgentToolResult, type AgentToolCallTelemetry } from "../../agentTools/dispatch";
import { QUESTIONS_ASK_LOGICAL_ID } from "../../agentTools/questionAsk";
import { prepareAgentRunnerToolSet } from "../../agentTools/runnerToolSet";
import type { AgentRunnerActivity, AgentRunnerToolSet } from "../AgentRunner";
import { combineRunnerToolSets } from "../shared/agentToolSets";
import { logger } from "../../logging/logger";
import {
  JsonRpcMethodNotFoundError,
  type JsonRpcRequest
} from "../shared/JsonRpcLineClient";
import { PendingQuestionRequests, type QuestionWaitOutcome } from "../shared/PendingQuestionRequests";
import {
  CURSOR_QUESTION_TOOL_NAME,
  cursorQuestionBatch,
  cursorQuestionToolResult,
  type CursorQuestionBatch
} from "./questions";
import {
  HOST_QUESTION_METHOD,
  HOST_TOOLS_INVOKE_METHOD,
  questionAskParamsSchema,
  toolInvokeParamsSchema
} from "./protocol";
import type { CursorActiveTurn, CursorRunnerSession } from "./types";

/**
 * The Cursor tool relay: where AgentRoom tool calls cross from the host child's
 * one custom-tool transport into the backend's bound dispatcher.
 *
 * The host registers every advertised catalog definition as a custom tool whose
 * `execute` sends one `tools/invoke` request carrying the tool's own name; the
 * original `question/ask` request remains as a compatibility shim for the same
 * call. This module serves both, binds the allowed set to the originating turn
 * (`agentTools/dispatch.ts` owns validation, liveness, correlation, bounding,
 * and cancellation refusal), and injects the existing question handler — the
 * pending store, the canonical question events, and the model-facing rendering
 * move here unchanged from `CursorSdkRunner`, not rebuilt.
 *
 * The relay is an allowlist, not an executor: a name outside the turn's bound
 * set never reaches a handler, and nothing here can run a shell command or hit
 * a backend route.
 */

/** Serve one host → backend request: the tool relay's two methods, or refuse. */
export async function serveCursorHostRequest(
  session: CursorRunnerSession,
  request: JsonRpcRequest
): Promise<{ result: string }> {
  if (request.method === HOST_TOOLS_INVOKE_METHOD) {
    const params = toolInvokeParamsSchema.parse(request.params);
    return { result: await dispatchCursorToolCall(session, params.tool, params.input, params.runId) };
  }
  if (request.method === HOST_QUESTION_METHOD) {
    const params = questionAskParamsSchema.parse(request.params);
    return { result: await dispatchCursorToolCall(session, CURSOR_QUESTION_TOOL_NAME, params.input) };
  }
  // The shared client refuses an unknown method with -32601 when the handler
  // throws; do the same by name so a future host method is not silently
  // answered.
  throw new JsonRpcMethodNotFoundError(request.method);
}

async function dispatchCursorToolCall(
  session: CursorRunnerSession,
  tool: string,
  input: unknown,
  hostRunId?: string
): Promise<string> {
  const turn = session.activeTurn;
  if (hostRunId !== undefined) {
    // The generation handle: a callback from a run that is not the session's
    // live turn — a late or replayed relay — is answered with the tool's
    // unavailable text, never dispatched into whichever turn is active now.
    // The live run's first call can arrive in the same chunk as the
    // `agent/send` answer, before the run id is recorded, so wait for it.
    const liveRunId = turn ? turn.cursorRunId ?? (await turn.cursorRunIdKnown) : undefined;
    if (liveRunId !== hostRunId || session.activeTurn !== turn) return unboundAgentToolResult(tool);
  }
  const bound = session.toolBinding;
  if (!bound) return unboundAgentToolResult(tool);
  // The host has no per-call cancel; turn disposal is what ends a call.
  return bound.tools.binding.invoke({ callId: `cursor-call-${randomUUID()}`, name: tool, arguments: input, signal: bound.signal });
}

/**
 * Bind the session's allowed AgentRoom tools to the turn starting now. The
 * binding is the turn's: its liveness is "still the session's live turn", so a
 * late relay from a settled or switched turn is answered with the tool's
 * unavailable text instead of being dispatched into the live turn.
 *
 * Every other tool arrives in the session-supplied set, already bound to the
 * AgentRoom turn; this adapter adds only the question tool it owns and never
 * learns what the session's tools do.
 */
export function bindCursorTurnTools(input: {
  session: CursorRunnerSession;
  turn: CursorActiveTurn;
  /** The adapter-owned question tool, when the question gate allows it. */
  questionIds: readonly string[];
  questions: PendingQuestionRequests;
  sessionTools?: AgentRunnerToolSet;
}): AgentRunnerToolSet {
  const { session, turn, questions } = input;
  const prepared = prepareAgentRunnerToolSet({
    runId: turn.runId,
    sessionKey: session.key,
    catalog: input.questionIds,
    allowed: input.questionIds,
    required: false,
    handlers: { [QUESTIONS_ASK_LOGICAL_ID]: (toolInput) => runQuestionToolCall(session, turn, questions, toolInput) },
    isLive: () => session.activeTurn === turn && !turn.completed,
    onCall: logToolCall
  });
  const lifetime = new AbortController();
  const tools = combineRunnerToolSets(input.sessionTools, prepared.tools);
  session.toolBinding = {
    tools,
    signal: lifetime.signal,
    dispose: () => {
      lifetime.abort();
      prepared.dispose();
    }
  };
  return tools;
}

/** End the turn's binding; a racing newer binding is left alone. */
export function disposeCursorTurnTools(session: CursorRunnerSession): void {
  const bound = session.toolBinding;
  if (!bound) return;
  bound.dispose();
  if (session.toolBinding === bound) session.toolBinding = undefined;
}

/** Safe metadata only — a tool's arguments and results never reach the log. */
function logToolCall(telemetry: AgentToolCallTelemetry): void {
  logger.info(
    {
      toolLogicalId: telemetry.logicalId,
      toolName: telemetry.name,
      callId: telemetry.callId,
      outcome: telemetry.outcome,
      durationMs: telemetry.durationMs,
      ...(telemetry.error ? { error: telemetry.error } : {}),
      ...(telemetry.late ? { late: telemetry.late } : {})
    },
    "AgentRoom tool call settled"
  );
}

/**
 * The `questions.ask` handler: the existing question behavior, moved unchanged.
 * The backend mints the request id, opens the shared wait against the injected
 * pending store, emits the canonical question pair while the turn can still
 * render them, and renders the outcome as the tool's model-facing text.
 */
async function runQuestionToolCall(
  session: CursorRunnerSession,
  turn: CursorActiveTurn,
  questions: PendingQuestionRequests,
  input: unknown
): Promise<string> {
  const batch = cursorQuestionBatch(input as Record<string, unknown>);
  if ("error" in batch) return batch.error;

  const requestId = `question-${randomUUID()}`;
  const wait = !turn.finalEvent
    ? questions.wait({ sessionKey: session.key, requestId, sets: batch.sets })
    : undefined;
  pushQuestionRequested(session, turn, batch, wait ? requestId : undefined);
  if (!wait) {
    pushQuestionResolved(session, turn, batch, requestId, { status: "cancelled" }, false);
    return cursorQuestionToolResult(batch, { status: "unavailable" });
  }

  turn.pendingQuestionRequestId = requestId;
  const outcome = await wait;
  if (turn.pendingQuestionRequestId === requestId) turn.pendingQuestionRequestId = undefined;
  pushQuestionResolved(session, turn, batch, requestId, outcome, true);
  return cursorQuestionToolResult(batch, outcome);
}

function pushQuestionRequested(
  session: CursorRunnerSession,
  turn: CursorActiveTurn,
  batch: CursorQuestionBatch,
  requestId: string | undefined
): void {
  if (!turn || turn.finalEvent) return;
  turn.queue.push({
    type: "agent_activity",
    activity: questionActivity(session, {
      kind: "cursor_question_requested",
      title: "Questions for you",
      content: { questionCount: batch.sets.length },
      canonical: { kind: "question_requested", ...(requestId ? { requestId } : {}), questionSets: batch.sets }
    })
  });
}

function pushQuestionResolved(
  session: CursorRunnerSession,
  turn: CursorActiveTurn,
  batch: CursorQuestionBatch,
  requestId: string,
  outcome: QuestionWaitOutcome | { status: "cancelled" },
  withRequestId: boolean
): void {
  if (!turn || turn.finalEvent) return;
  turn.queue.push({
    type: "agent_activity",
    activity: questionActivity(session, {
      kind: "cursor_question_resolved",
      title:
        outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
      content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
      canonical: {
        kind: "question_resolved",
        ...(withRequestId ? { requestId } : {}),
        status: outcome.status,
        ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
        ...(outcome.status === "answered"
          ? {
              // A sensitive set's text reaches only the tool result. Ordinary
              // invited discussion remains in the canonical event and thread.
              questionAnswers: outcome.answers.map((answer) =>
                batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                  ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds }
                  : answer
              )
            }
          : {})
      }
    })
  });
}

/** Release the turn's outstanding question batch: the cancel ladder's first rung. */
export function cancelCursorPendingQuestion(
  session: CursorRunnerSession,
  turn: CursorActiveTurn,
  questions: PendingQuestionRequests
): void {
  const requestId = turn.pendingQuestionRequestId;
  if (!requestId) return;
  turn.pendingQuestionRequestId = undefined;
  questions.cancel(session.key, requestId);
}

function questionActivity(session: CursorRunnerSession, activity: Omit<AgentRunnerActivity, "runner">): AgentRunnerActivity {
  return { ...activity, runner: session.base };
}
