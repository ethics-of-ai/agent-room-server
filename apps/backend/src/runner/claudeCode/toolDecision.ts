import { randomUUID } from "node:crypto";
import type { AgentRunnerActivity } from "../AgentRunner";
import type { PendingQuestionRequests, QuestionWaitOutcome } from "../shared/PendingQuestionRequests";
import {
  ASK_USER_QUESTION_TOOL,
  HEADLESS_PERMISSION_DENY_MESSAGE,
  askUserQuestionBatch,
  askUserQuestionUpdatedInput
} from "./askUserQuestion";
import type { ClaudeCodeRunnerSession } from "./runnerSession";
import type { ClaudeCodeCanUseTool } from "./sdk";

/**
 * The SDK `canUseTool` callback for one AgentRoom session.
 *
 * `AskUserQuestion` is the one tool it holds open: the questions become a
 * canonical batch announced on the turn's event stream, the wait sits in the
 * shared store until the answer route settles it (or the clock, or the
 * turn's own interrupt through `signal`), and the answers go back as the
 * tool's `updatedInput`. Every other tool is refused with the CLI's own
 * headless wording — under `bypassPermissions` none reaches here, and under a
 * stricter mode they were refused headless before this callback existed —
 * so supplying it changes nothing about what an agent may do.
 */
export async function decideClaudeCodeToolUse(
  questions: PendingQuestionRequests,
  sessionKey: string,
  getSession: () => ClaudeCodeRunnerSession | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { signal?: AbortSignal; toolUseID?: string }
): ReturnType<ClaudeCodeCanUseTool> {
  // AgentRoom's own tools, by exact name; `allowedTools` normally approves
  // them before this callback is consulted.
  if (getSession()?.tools?.allows(toolName)) return { behavior: "allow", updatedInput: toolInput };
  if (toolName !== ASK_USER_QUESTION_TOOL) {
    return { behavior: "deny", message: HEADLESS_PERMISSION_DENY_MESSAGE };
  }
  const batch = askUserQuestionBatch(toolInput);
  if ("error" in batch) return { behavior: "deny", message: batch.error };

  const session = getSession();
  const turn = session?.activeTurn;
  const requestId = `question-${randomUUID()}`;
  const wait = turn && !turn.finalEvent
    ? questions.wait({ sessionKey, requestId, sets: batch.sets })
    : undefined;
  const runner = {
    ...(session?.sdkSessionId ? { nativeSessionId: session.sdkSessionId } : {}),
    ...(options.toolUseID ? { nativeItemId: options.toolUseID } : {})
  };
  const pushActivity = (activity: AgentRunnerActivity): void => {
    const target = getSession()?.activeTurn;
    if (target && !target.finalEvent) target.queue.push({ type: "agent_activity", activity });
  };
  pushActivity({
    kind: "claude_code_question_requested",
    title: "Questions for you",
    content: { questionCount: batch.sets.length, ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}) },
    canonical: { kind: "question_requested", ...(wait ? { requestId } : {}), questionSets: batch.sets },
    runner
  });
  if (!wait) {
    pushActivity({
      kind: "claude_code_question_resolved",
      title: "Questions not presented",
      content: { status: "cancelled" },
      canonical: { kind: "question_resolved", status: "cancelled" },
      runner
    });
    return { behavior: "allow", updatedInput: askUserQuestionUpdatedInput(toolInput, batch, { status: "unavailable" }) };
  }

  const abort = (): void => {
    questions.cancel(sessionKey, requestId);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let outcome: QuestionWaitOutcome;
  try {
    outcome = await wait;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  pushActivity({
    kind: "claude_code_question_resolved",
    title: outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
    content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
    canonical: {
      kind: "question_resolved",
      requestId,
      status: outcome.status,
      ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
      ...(outcome.status === "answered" ? { questionAnswers: outcome.answers } : {})
    },
    runner
  });
  if (outcome.status === "cancelled") {
    return { behavior: "deny", message: "Turn cancelled" };
  }
  return { behavior: "allow", updatedInput: askUserQuestionUpdatedInput(toolInput, batch, outcome) };
}
