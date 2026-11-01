import type { AgentRunner, CanonicalQuestionAnswer } from "../runner/AgentRunner";
import { questionAnswerRefusal, type QuestionAnswerResult } from "../runner/shared/PendingQuestionRequests";
import { AgentSessionError } from "./agentSessionTypes";

/**
 * Answer an outstanding permission request with an option the runner is
 * holding for it.
 *
 * The runner decides whether the request is still outstanding and whether the
 * option was one the agent offered; this only maps those answers onto status
 * codes. A runner with no approval channel has no outstanding request either,
 * which is the same 404. The route never reads which runner this is.
 */
export function answerPermission(runner: AgentRunner, input: { sessionId: string; requestId: string; optionId: string }): void {
  const answer = runner.answerPermissionRequest?.(input) ?? "unknown_request";
  if (answer === "unknown_request") {
    throw new AgentSessionError("Permission request is not outstanding for this session", 404);
  }
  if (answer === "unknown_option") {
    // The agent decides what it is willing to be told; an option it did not
    // offer is refused rather than forwarded.
    throw new AgentSessionError("Permission option was not offered for this request", 400);
  }
}

/**
 * Answer an outstanding clarifying-question batch. A batch a backend tool
 * asked is answered in the session's own channel; any other goes to the
 * runner, which decides whether it is outstanding and every set and option
 * was offered. A batch nobody holds is a 404. The runner is resolved only
 * when the session's channel does not hold the batch.
 */
export function answerQuestion(
  input: { sessionId: string; requestId: string; answers: CanonicalQuestionAnswer[] },
  channel: { answer(sessionId: string, requestId: string, answers: readonly CanonicalQuestionAnswer[]): QuestionAnswerResult | undefined },
  runner: () => AgentRunner
): void {
  const answer = channel.answer(input.sessionId, input.requestId, input.answers) ?? runner().answerQuestionRequest?.(input) ?? "unknown_request";
  if (answer === "unknown_request") {
    throw new AgentSessionError("Question request is not outstanding for this session", 404);
  }
  if (answer !== "answered") {
    throw new AgentSessionError(questionAnswerRefusal[answer], 400);
  }
}
