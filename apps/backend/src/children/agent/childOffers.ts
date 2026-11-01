import type { SessionQuestionOutcome } from "../../agent/SessionQuestionChannel";
import { MAX_QUESTION_PROMPT_LENGTH, type QuestionRequestSet } from "../../runner/shared/PendingQuestionRequests";
import type { ChildTaskInput } from "./childToolContract";

/**
 * The worktree offer card (decision 5). Before an agent's own `offer`
 * creates anything, AgentRoom asks the person through the session question
 * channel, one set per task: **New worktree thread** or **Do it here**. A
 * child is created only for a task answered with the first. The card is an
 * ordinary clarifying question and changes no posture.
 */

export type ChildOfferAsk = (sets: readonly QuestionRequestSet[], signal?: AbortSignal) => Promise<SessionQuestionOutcome>;

export const OFFER_HEADER = "Worktree?";
export const OFFER_WORKTREE = "worktree";
export const OFFER_HERE = "here";

/** What the person chose for one task; `unanswered` is a set they left blank. */
export type OfferDecision = "worktree" | "here" | "unanswered";

/** The card's answer: a decision per offered task, or a call-level refusal that creates nothing. */
export type OfferOutcome =
  | { kind: "answered"; decisions: Map<number, OfferDecision> }
  | { kind: "refused"; code: "unanswered" | "unavailable" | "offer_unavailable" };

/** The set id of the task at `index` in the call, so an answer maps back to its task. */
export function offerSetId(index: number): string {
  return `task-${index}`;
}

/** One set per task, in call order. `baseCommit` is the parent's current `HEAD`, shown short. */
export function offerSets(tasks: ReadonlyArray<{ index: number; task: ChildTaskInput }>, baseCommit: string): QuestionRequestSet[] {
  return tasks.map(({ index, task }) => ({
    setId: offerSetId(index),
    header: OFFER_HEADER,
    prompt: offerPrompt(task, baseCommit),
    selection: "single",
    options: [{ optionId: OFFER_WORKTREE, label: "New worktree thread" }, { optionId: OFFER_HERE, label: "Do it here" }],
    discussion: "none"
  }));
}

export function offerPrompt(task: Pick<ChildTaskInput, "title" | "reason">, baseCommit: string): string {
  const prompt = `The agent wants to hand "${task.title}" to a new child thread. It would work in its own worktree, ` +
    `on a new branch from commit ${baseCommit.slice(0, 7)}, without this thread's uncommitted changes. The agent's reason: ${task.reason}`;
  return prompt.slice(0, MAX_QUESTION_PROMPT_LENGTH);
}

/**
 * The outcome mapping: an answer decides each set; a timeout is `unanswered`;
 * a withdrawn question or a turn that ended is `unavailable`; questions
 * turned off is `offer_unavailable`. Only an answer can create a child.
 */
export function offerOutcome(outcome: SessionQuestionOutcome, indexes: readonly number[]): OfferOutcome {
  switch (outcome.status) {
    case "answered": {
      const decisions = new Map<number, OfferDecision>();
      for (const index of indexes) {
        const selected = outcome.answers.find((answer) => answer.setId === offerSetId(index))?.selectedOptionIds ?? [];
        decisions.set(index, selected.includes(OFFER_WORKTREE) ? "worktree" : selected.includes(OFFER_HERE) ? "here" : "unanswered");
      }
      return { kind: "answered", decisions };
    }
    case "timeout":
      return { kind: "refused", code: "unanswered" };
    case "cancelled":
      return { kind: "refused", code: "unavailable" };
    case "unavailable":
      return { kind: "refused", code: outcome.reason === "questions_off" ? "offer_unavailable" : "unavailable" };
  }
}

/** The model-facing text for each call-level refusal and for a task the person left blank. */
export const OFFER_MESSAGES = {
  unanswered: "Nobody answered the worktree question in time, so nothing was created. Say so and stop; do not do this work here unless the person asks.",
  unavailable: "AgentRoom could not finish asking the person, because the question was withdrawn or this turn ended, so nothing was created.",
  offer_unavailable: "Clarifying questions are turned off, so AgentRoom cannot ask the person about a worktree and created nothing. " +
    "Do the work here, or ask the person in your reply whether they want a child thread.",
  unansweredTask: "The person answered the card but left this task blank, so no child was created for it. Ask the person what they want for it."
} as const;
