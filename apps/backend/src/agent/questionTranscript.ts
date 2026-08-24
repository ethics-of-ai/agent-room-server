import type { CanonicalQuestionAnswer, CanonicalQuestionSet } from "../runner/AgentRunner";

/**
 * The transcript record of a human answer to a clarifying-question batch.
 *
 * The backend appends this as a `role: "user"` message once a person answers,
 * so `/messages` shows the decision on reconnect the way it shows the turn
 * message that preceded it. It is the same rendering for every runner — what
 * the *agent* sees is each adapter's own mapping of the same answer — and it
 * names sets by their header or ordinal, the chosen labels, and the person's
 * own words where a set offered the free-text escape. A sensitive set's text is
 * never rendered: it went to the agent and nowhere else.
 */
export function renderQuestionAnswers(
  sets: readonly CanonicalQuestionSet[],
  answers: readonly CanonicalQuestionAnswer[]
): string {
  const answersBySet = new Map(answers.map((answer) => [answer.setId, answer] as const));
  return sets
    .map((set, index) => {
      const title = set.header?.trim() ? set.header.trim() : `Question ${index + 1}`;
      const answer = answersBySet.get(set.setId);
      const lines = [`${title}: ${set.prompt}`];
      if (!answer) {
        lines.push("→ (unanswered)");
        return lines.join("\n");
      }
      const labels = answer.selectedOptionIds.map(
        (optionId) => set.options.find((option) => option.optionId === optionId)?.label ?? optionId
      );
      if (labels.length > 0) lines.push(`→ ${labels.join(", ")}`);
      if (answer.discussion?.trim()) {
        lines.push(set.sensitive ? "[redacted]" : answer.discussion.trim());
      } else if (labels.length === 0) {
        lines.push("→ (unanswered)");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
