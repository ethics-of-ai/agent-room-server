import type { CanonicalQuestionSet } from "../AgentRunner";
import {
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_SETS,
  isValidQuestionRequestBatch,
  type QuestionWaitOutcome
} from "./PendingQuestionRequests";

import { QUESTIONS_ASK_UNAVAILABLE_RESULT } from "../../agentTools/questionAsk";

/** What the model reads when the bounded wait ends with no answer. */
export const NATIVE_QUESTION_TIMEOUT_RESULT =
  "No answer arrived in time; the person may be away. Proceed with your best judgment and state the assumptions you made.";

/** What the model reads when the turn was cancelled while it waited. */
export const NATIVE_QUESTION_CANCELLED_RESULT = "The turn was cancelled before an answer arrived.";

interface NativeSet {
  question: string;
  labelsByOptionId: Map<string, string>;
}

export interface NativeQuestionBatch {
  sets: CanonicalQuestionSet[];
  /** setId → the question text and its option labels, for rendering the answer. */
  native: Map<string, NativeSet>;
}

/**
 * Map the tool's `questions` into canonical sets with AgentRoom-minted ids, or
 * a refusal the model can act on. Never a truncated vocabulary, which would let
 * the model believe an option it offered was on the table.
 */
export function nativeQuestionBatch(input: Record<string, unknown>): NativeQuestionBatch | { error: string } {
  const questions = Array.isArray(input.questions) ? input.questions : undefined;
  if (!questions || questions.length === 0) return { error: "ask_user_question needs at least one question" };
  if (questions.length > MAX_QUESTION_SETS) {
    return { error: `ask_user_question accepts at most ${MAX_QUESTION_SETS} questions per call` };
  }
  const sets: CanonicalQuestionSet[] = [];
  const native = new Map<string, NativeSet>();
  const seenQuestions = new Set<string>();
  for (const [index, raw] of questions.entries()) {
    const question = objectValue(raw);
    const prompt = stringValue(question?.question);
    if (!question || !prompt) return { error: `ask_user_question question ${index + 1} has no question text` };
    if (seenQuestions.has(prompt)) return { error: "ask_user_question question texts must be unique" };
    seenQuestions.add(prompt);
    const selection = stringValue(question.selection);
    if (selection !== "single" && selection !== "multiple") {
      return { error: `ask_user_question question ${index + 1} has an invalid selection mode` };
    }
    const discussion = stringValue(question.discussion);
    if (discussion !== "none" && discussion !== "optional" && discussion !== "required") {
      return { error: `ask_user_question question ${index + 1} has an invalid discussion mode` };
    }
    if (question.sensitive !== undefined && typeof question.sensitive !== "boolean") {
      return { error: `ask_user_question question ${index + 1} has an invalid sensitive flag` };
    }
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length === 0 && discussion !== "required") {
      return { error: `ask_user_question question ${index + 1} offers no answer path` };
    }
    if (options.length > MAX_QUESTION_OPTIONS) {
      return { error: `ask_user_question accepts at most ${MAX_QUESTION_OPTIONS} options per question` };
    }
    const setId = `set-${index + 1}`;
    const labelsByOptionId = new Map<string, string>();
    const seenLabels = new Set<string>();
    const mappedOptions: CanonicalQuestionSet["options"] = [];
    for (const [optionIndex, rawOption] of options.entries()) {
      const option = objectValue(rawOption);
      const label = stringValue(option?.label);
      if (!option || !label) return { error: `ask_user_question question ${index + 1} has an option without a label` };
      if (seenLabels.has(label)) return { error: "ask_user_question option labels must be unique within a question" };
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
      selection,
      options: mappedOptions,
      discussion,
      ...(question.sensitive === true ? { sensitive: true } : {})
    });
    native.set(setId, { question: prompt, labelsByOptionId });
  }
  if (!isValidQuestionRequestBatch(sets)) {
    return { error: "ask_user_question batch exceeds AgentRoom's question bounds" };
  }
  return { sets, native };
}

/**
 * The text the tool returns to the model for a settled batch. A human answer
 * names each answered question, the labels chosen, and any free text; a
 * timeout, cancellation, or unpresentable batch says so and asks the model to
 * continue. A sensitive set's free text still reaches the model here — that is
 * the point — and nowhere else.
 */
export function nativeQuestionToolResult(
  batch: NativeQuestionBatch,
  outcome: QuestionWaitOutcome | { status: "unavailable" }
): string {
  if (outcome.status === "timeout") return NATIVE_QUESTION_TIMEOUT_RESULT;
  if (outcome.status === "unavailable") return QUESTIONS_ASK_UNAVAILABLE_RESULT;
  if (outcome.status === "cancelled") return NATIVE_QUESTION_CANCELLED_RESULT;

  const lines: string[] = ["The person answered:"];
  for (const answer of outcome.answers) {
    const nativeSet = batch.native.get(answer.setId);
    if (!nativeSet) continue;
    const labels = answer.selectedOptionIds
      .map((optionId) => nativeSet.labelsByOptionId.get(optionId))
      .filter((label): label is string => label !== undefined);
    const discussion = answer.discussion?.trim();
    const choice = labels.length > 0 ? labels.join(", ") : discussion ? "(free text only)" : "(no choice)";
    const notes = discussion ? ` — notes: ${discussion}` : "";
    lines.push(`- ${nativeSet.question}: ${choice}${notes}`);
  }
  const answeredSetIds = new Set(outcome.answers.map((answer) => answer.setId));
  for (const set of batch.sets) {
    if (!answeredSetIds.has(set.setId)) {
      lines.push(`- ${set.prompt}: (unanswered — do not invent a choice)`);
    }
  }
  return lines.join("\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
