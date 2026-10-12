import type { SessionQuestionOutcome } from "../../agent/SessionQuestionChannel";
import type { QuestionRequestSet } from "../../runner/shared/PendingQuestionRequests";
import { applyOperations, type SketchDocument, type SketchOperation } from "../core";
import { sketchTitleFromPath } from "../index/sketchReference";

/**
 * The person's confirmation before an agent deletes a sketch file or empties
 * a sketch. The question names the sketch, its path, and its object count,
 * and the change happens only on an explicit yes. Everything else (no, a
 * timeout, a cancelled turn, questions turned off) refuses.
 */

export type SketchAsk = (sets: readonly QuestionRequestSet[], signal?: AbortSignal) => Promise<SessionQuestionOutcome>;

const YES = "yes";

export function confirmationSet(prompt: string, yesLabel: string): QuestionRequestSet[] {
  return [{
    setId: "confirm",
    header: "Confirm",
    prompt,
    selection: "single",
    options: [{ optionId: YES, label: yesLabel }, { optionId: "no", label: "Keep it" }],
    discussion: "none"
  }];
}

export function deletePrompt(path: string, document: SketchDocument): string {
  return `An agent wants to delete the sketch "${sketchTitleFromPath(path)}" (${path}, ${document.objects.length} object(s)). Delete the file?`;
}

export function clearPrompt(path: string, document: SketchDocument, label: string): string {
  return `An agent wants to remove every object from the sketch "${sketchTitleFromPath(path)}" (${path}, ${document.objects.length} object(s)) ` +
    `in a step labelled "${label}". You can undo it afterwards. Go ahead?`;
}

/** The refusal for anything but a yes, or undefined for a yes. */
export function confirmationRefusal(outcome: SessionQuestionOutcome, what: string): string | undefined {
  switch (outcome.status) {
    case "answered":
      return outcome.answers.some((answer) => answer.selectedOptionIds.includes(YES))
        ? undefined
        : `error declined: the person said no, so ${what}. Do not try again unless they ask.`;
    case "timeout":
      return `error confirmation_timeout: nobody answered in time, so ${what}.`;
    case "cancelled":
      return `error confirmation_cancelled: the question was withdrawn, so ${what}.`;
    case "unavailable":
      return `error confirmation_unavailable: AgentRoom could not ask the person (questions are turned off or the turn ended), so ${what}. Tell the person.`;
  }
}

/**
 * Whether a batch would empty a non-empty sketch: it contains `clear`, or a
 * dry run on the current document leaves no objects. Evaluated before the
 * edit, so clear-all cannot be spelled as a delete per object to skip the
 * question.
 */
export function batchClearsSketch(document: SketchDocument, operations: readonly SketchOperation[]): boolean {
  if (document.objects.length === 0) return false;
  if (operations.some((operation) => operation.op === "clear")) return true;
  const working = structuredClone(document);
  const applied = applyOperations(working, [...operations]);
  return applied.ok && working.objects.length === 0;
}
