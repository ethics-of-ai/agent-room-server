import { randomUUID } from "node:crypto";
import { logger } from "../../logging/logger";
import type { AgentRunnerActivity } from "../AgentRunner";
import type { PendingQuestionRequests, QuestionWaitOutcome } from "../shared/PendingQuestionRequests";
import type { CodexRunnerSession } from "./types";
import {
  CODEX_REQUEST_USER_INPUT_METHOD,
  codexUserInputBatch,
  codexUserInputRequestSchema,
  codexUserInputResponse
} from "./userInput";

/**
 * Hold a `request_user_input` batch open for a human answer.
 *
 * The questions become a canonical batch announced on the turn's event
 * stream, the wait sits in the shared store until the answer route settles
 * it (or the clock, or the turn's cancellation), and the answers go back as
 * the request's response keyed by the agent's own question ids. A batch the
 * backend cannot hold open — no live turn, a full session, a request outside
 * the bounds — is announced as a record and answered empty, which the agent
 * reads as "nobody answered": the channel never picks for the person.
 */
export async function decideCodexUserInput(
session: CodexRunnerSession,
params: unknown,
deps: { questions: PendingQuestionRequests; touch(session: CodexRunnerSession): void }
): Promise<unknown> {
  const parsed = codexUserInputRequestSchema.safeParse(params);
  if (!parsed.success) {
    logger.warn({ runnerKind: "codex", threadId: session.threadId }, "Codex request_user_input params failed validation");
    return { answers: {} };
  }
  const batch = codexUserInputBatch(parsed.data);
  if ("error" in batch) {
    logger.warn({ runnerKind: "codex", threadId: session.threadId, reason: batch.error }, "Codex request_user_input batch refused");
    return { answers: {} };
  }
  deps.touch(session);
  const turn = session.activeTurn;
  const requestId = `question-${randomUUID()}`;
  const wait = turn && !turn.finalEvent
    ? deps.questions.wait({ sessionKey: session.key, requestId, sets: batch.sets })
    : undefined;
  const runner = {
    nativeSessionId: session.threadId,
    ...(parsed.data.turnId ? { nativeTurnId: parsed.data.turnId } : {}),
    ...(parsed.data.itemId ? { nativeItemId: parsed.data.itemId } : {}),
    native: { method: CODEX_REQUEST_USER_INPUT_METHOD }
  };
  const pushActivity = (activity: AgentRunnerActivity): void => {
    const target = session.activeTurn;
    if (target && !target.finalEvent) target.queue.push({ type: "agent_activity", activity });
  };
  pushActivity({
    kind: "codex_question_requested",
    title: "Questions for you",
    content: { questionCount: batch.sets.length, ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}) },
    canonical: { kind: "question_requested", ...(wait ? { requestId } : {}), questionSets: batch.sets },
    runner
  });
  if (!wait) {
    pushActivity({
      kind: "codex_question_resolved",
      title: "Questions not presented",
      content: { status: "cancelled" },
      canonical: { kind: "question_resolved", status: "cancelled" },
      runner
    });
    return codexUserInputResponse(batch, { status: "unavailable" });
  }
  const outcome: QuestionWaitOutcome = await wait;
  pushActivity({
    kind: "codex_question_resolved",
    title: outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
    content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
    canonical: {
      kind: "question_resolved",
      requestId,
      status: outcome.status,
      ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
      ...(outcome.status === "answered"
        ? {
            // A sensitive set's text reaches the agent and nowhere else.
            questionAnswers: outcome.answers.map((answer) =>
              batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds }
                : answer
            )
          }
        : {})
    },
    runner
  });
  return codexUserInputResponse(batch, outcome);
}
