import { randomUUID } from "node:crypto";
import type { AgentRunnerActivity, CanonicalQuestionAnswer } from "../runner/AgentRunner";
import {
  PendingQuestionRequests,
  type QuestionAnswerResult,
  type QuestionRequestSet,
  type QuestionWaitOutcome
} from "../runner/shared/PendingQuestionRequests";

/**
 * Clarifying questions asked by a backend-owned tool rather than a runner.
 * The four adapters keep their own question flows; this channel serves tools
 * that run in the backend, such as the sketch tools asking before a delete.
 *
 * It holds its own `PendingQuestionRequests` with the same bounds, timeout,
 * and answer validation, and publishes the same canonical `question_requested`
 * and `question_resolved` activities on the session's running turn, so a
 * client answers it through the ordinary answer route. The session service
 * checks this channel before the runner, and turn end and session close
 * release what it holds as cancelled.
 */
export type SessionQuestionOutcome = QuestionWaitOutcome | { status: "unavailable" };

export class SessionQuestionChannel {
  private readonly questions: PendingQuestionRequests;

  constructor(private readonly deps: {
    /** The clarifying-question setting; off, every ask is unavailable. */
    enabled(): boolean;
    /** Publish an activity on the session's turn, as a runner would. */
    publish(sessionId: string, turnId: string, activity: AgentRunnerActivity): void;
    timeoutMs?: number;
  }) {
    this.questions = new PendingQuestionRequests(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs });
  }

  async ask(input: {
    sessionId: string;
    turnId: string;
    sets: readonly QuestionRequestSet[];
    isLive(): boolean;
    signal?: AbortSignal;
  }): Promise<SessionQuestionOutcome> {
    if (!this.deps.enabled() || !input.isLive() || input.signal?.aborted) return { status: "unavailable" };
    const requestId = `question-${randomUUID()}`;
    const wait = this.questions.wait({ sessionKey: input.sessionId, requestId, sets: input.sets });
    if (!wait) return { status: "unavailable" };
    this.deps.publish(input.sessionId, input.turnId, {
      kind: "agentroom_question_requested",
      title: "Questions for you",
      content: { questionCount: input.sets.length },
      canonical: { kind: "question_requested", requestId, questionSets: [...input.sets] }
    });
    const abort = () => this.questions.cancel(input.sessionId, requestId);
    input.signal?.addEventListener("abort", abort, { once: true });
    const outcome = await wait;
    input.signal?.removeEventListener("abort", abort);
    // Turn end already reported its open questions as cancelled.
    if (outcome.status !== "cancelled" || input.isLive()) {
      this.deps.publish(input.sessionId, input.turnId, {
        kind: "agentroom_question_resolved",
        title: outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
        content: { status: outcome.status },
        canonical: {
          kind: "question_resolved",
          requestId,
          status: outcome.status,
          ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
          ...(outcome.status === "answered" ? { questionAnswers: outcome.answers } : {})
        }
      });
    }
    return outcome;
  }

  /** Answer a batch this channel holds, or undefined when it holds no such request. */
  answer(sessionId: string, requestId: string, answers: readonly CanonicalQuestionAnswer[]): QuestionAnswerResult | undefined {
    if (this.questions.outstanding(sessionId, requestId) === undefined) return undefined;
    return this.questions.answer(sessionId, requestId, answers);
  }

  release(sessionId: string): void {
    this.questions.releaseSession(sessionId);
  }
}
