import type { CanonicalQuestionSet } from "../AgentRunner";
import {
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_SETS,
  isValidQuestionRequestBatch,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";

/**
 * The Claude Code half of the clarifying-question channel: the pure mapping
 * between the CLI's `AskUserQuestion` tool and AgentRoom's canonical batch.
 *
 * The CLI routes that tool through the SDK `canUseTool` callback before any
 * permission mode is consulted, and reads the answers back off the input the
 * callback returns (`updatedInput.answers`, keyed by question text;
 * `annotations[question].notes` for free text beside a choice; a top-level
 * `response` for free text instead of one). This module turns the tool's input
 * into minted-id sets and a batch outcome back into that shape; the runner
 * owns the wait. Verified against SDK 0.3.172 / CLI 2.1.172:
 * the model sees `"Q"="Label" notes: …` per answered question, an omitted
 * question as absent, and `response` as `The user responded: …`.
 */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** The CLI's own wording for a prompt it cannot raise, kept so the model's experience is unchanged. */
export const HEADLESS_PERMISSION_DENY_MESSAGE =
  "Action requires interactive approval and permission prompts are not available in this context";

/**
 * What the model reads when the bounded wait ends with no answer. The CLI's
 * own away-from-keyboard marker renders only as "The user did not answer" on
 * the bundled CLI and left the model re-asking, so the fallback names the
 * situation and what to do instead.
 */
export const QUESTION_TIMEOUT_RESPONSE =
  "No answer arrived in time; the user may be away. Proceed with your best judgment and state the assumptions you made.";

/** What the model reads when AgentRoom could not hold the batch open at all. */
export const QUESTION_UNAVAILABLE_RESPONSE =
  "These questions could not be put to the user right now. Proceed with your best judgment and state the assumptions you made.";

/** The CLI's own sentinel for "no option chosen, notes only". */
const NOTES_ONLY_ANSWER = "(notes only)";

interface NativeSet {
  question: string;
  labelsByOptionId: Map<string, string>;
}

export interface AskUserQuestionBatch {
  sets: CanonicalQuestionSet[];
  /** setId → the CLI's own keys, so an answer can be written back by question text and label. */
  native: Map<string, NativeSet>;
}

/**
 * Map the tool's `questions` into canonical sets with AgentRoom-minted ids.
 * Returns a refusal the model can act on for a batch outside the bounds —
 * never a truncated vocabulary, which would let the model believe an option it
 * offered was on the table.
 */
export function askUserQuestionBatch(input: Record<string, unknown>): AskUserQuestionBatch | { error: string } {
  const questions = Array.isArray(input.questions) ? input.questions : undefined;
  if (!questions || questions.length === 0) return { error: "AskUserQuestion needs at least one question" };
  if (questions.length > MAX_QUESTION_SETS) {
    return { error: `AskUserQuestion accepts at most ${MAX_QUESTION_SETS} questions per call` };
  }
  const sets: CanonicalQuestionSet[] = [];
  const native = new Map<string, NativeSet>();
  const seenQuestions = new Set<string>();
  for (const [index, raw] of questions.entries()) {
    const question = objectValue(raw);
    const prompt = stringValue(question?.question);
    if (!question || !prompt) return { error: `AskUserQuestion question ${index + 1} has no question text` };
    if (seenQuestions.has(prompt)) return { error: "AskUserQuestion question texts must be unique" };
    seenQuestions.add(prompt);
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length === 0) return { error: `AskUserQuestion question ${index + 1} offers no options` };
    if (options.length > MAX_QUESTION_OPTIONS) {
      return { error: `AskUserQuestion accepts at most ${MAX_QUESTION_OPTIONS} options per question` };
    }
    const setId = `set-${index + 1}`;
    const labelsByOptionId = new Map<string, string>();
    const seenLabels = new Set<string>();
    const mappedOptions: CanonicalQuestionSet["options"] = [];
    for (const [optionIndex, rawOption] of options.entries()) {
      const option = objectValue(rawOption);
      const label = stringValue(option?.label);
      if (!option || !label) return { error: `AskUserQuestion question ${index + 1} has an option without a label` };
      if (seenLabels.has(label)) return { error: "AskUserQuestion option labels must be unique within a question" };
      seenLabels.add(label);
      const optionId = `opt-${optionIndex + 1}`;
      labelsByOptionId.set(optionId, label);
      const description = stringValue(option.description);
      mappedOptions.push({ optionId, label, ...(description ? { description } : {}) });
    }
    const header = stringValue(question.header);
    sets.push({
      setId,
      ...(header ? { header } : {}),
      prompt,
      selection: question.multiSelect === true ? "multiple" : "single",
      options: mappedOptions,
      discussion: "optional"
    });
    native.set(setId, { question: prompt, labelsByOptionId });
  }
  if (!isValidQuestionRequestBatch(sets)) {
    return { error: "AskUserQuestion batch exceeds AgentRoom's question bounds" };
  }
  return { sets, native };
}

/**
 * The `updatedInput` the callback returns for a settled batch. A human answer
 * writes each answered question back by its text — labels joined the way the
 * CLI joins multi-select answers, the CLI's own notes-only sentinel for free
 * text without a choice — and every free-text entry as that question's notes,
 * which the model sees beside the answer. A timeout or an unpresentable batch
 * answers nothing and says why in `response`.
 */
export function askUserQuestionUpdatedInput(
  input: Record<string, unknown>,
  batch: AskUserQuestionBatch,
  outcome: QuestionWaitOutcome | { status: "unavailable" }
): Record<string, unknown> {
  if (outcome.status !== "answered") {
    return {
      ...input,
      answers: {},
      response: outcome.status === "timeout" ? QUESTION_TIMEOUT_RESPONSE : QUESTION_UNAVAILABLE_RESPONSE
    };
  }
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const answer of outcome.answers) {
    const nativeSet = batch.native.get(answer.setId);
    if (!nativeSet) continue;
    const labels = answer.selectedOptionIds
      .map((optionId) => nativeSet.labelsByOptionId.get(optionId))
      .filter((label): label is string => label !== undefined);
    const discussion = answer.discussion?.trim();
    if (labels.length > 0) {
      answers[nativeSet.question] = labels.join(", ");
    } else if (discussion) {
      answers[nativeSet.question] = NOTES_ONLY_ANSWER;
    }
    if (discussion) annotations[nativeSet.question] = { notes: discussion };
  }
  return {
    ...input,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
