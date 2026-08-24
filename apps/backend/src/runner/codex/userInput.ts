import { z } from "zod";
import type { CanonicalQuestionSet } from "../AgentRunner";
import {
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_SETS,
  isValidQuestionRequestBatch,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";

/**
 * The Codex half of the clarifying-question channel: the pure mapping between
 * the app-server's `item/tool/requestUserInput` server→client request and
 * AgentRoom's canonical batch.
 *
 * The agent's `request_user_input` tool raises one request per call with one
 * to three questions, each with a stable `id`, a short `header`, the question
 * text, and two or three options; the client is expected to add a free-form
 * "Other" of its own, which is why every set here invites free text. The
 * response maps question ids to answer strings — labels for chosen options,
 * the typed text for "Other" — and an id the response omits reads to the model
 * as unanswered. Verified against codex-cli 0.149 (Phase 0 spike); the runner
 * owns the wait and the thread flags that make the tool available.
 */
export const CODEX_REQUEST_USER_INPUT_METHOD = "item/tool/requestUserInput";

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional().nullable()
});

const questionSchema = z.object({
  id: z.string().min(1),
  header: z.string().optional().nullable(),
  question: z.string().min(1),
  isOther: z.boolean().optional().nullable(),
  isSecret: z.boolean().optional().nullable(),
  options: z.array(optionSchema).optional().nullable()
});

export const codexUserInputRequestSchema = z
  .object({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    questions: z.array(questionSchema).min(1),
    isBlocking: z.boolean().optional().nullable()
  })
  .passthrough();

export type CodexUserInputRequest = z.infer<typeof codexUserInputRequestSchema>;

interface NativeSet {
  questionId: string;
  labelsByOptionId: Map<string, string>;
}

export interface CodexUserInputBatch {
  sets: CanonicalQuestionSet[];
  /** setId → the agent's own question id and option labels, for the response. */
  native: Map<string, NativeSet>;
}

/**
 * Map the request's questions into canonical sets with AgentRoom-minted ids.
 * A request outside the bounds is refused as a whole rather than truncated: an
 * option the person never saw must not be one the model believes was offered.
 */
export function codexUserInputBatch(request: CodexUserInputRequest): CodexUserInputBatch | { error: string } {
  if (request.questions.length > MAX_QUESTION_SETS) {
    return { error: `request_user_input accepts at most ${MAX_QUESTION_SETS} questions per call` };
  }
  const sets: CanonicalQuestionSet[] = [];
  const native = new Map<string, NativeSet>();
  const seenIds = new Set<string>();
  for (const [index, question] of request.questions.entries()) {
    if (seenIds.has(question.id)) return { error: "request_user_input question ids must be unique" };
    seenIds.add(question.id);
    const options = question.options ?? [];
    if (options.length > MAX_QUESTION_OPTIONS) {
      return { error: `request_user_input accepts at most ${MAX_QUESTION_OPTIONS} options per question` };
    }
    const setId = `set-${index + 1}`;
    const labelsByOptionId = new Map<string, string>();
    const mappedOptions: CanonicalQuestionSet["options"] = options.map((option, optionIndex) => {
      const optionId = `opt-${optionIndex + 1}`;
      labelsByOptionId.set(optionId, option.label);
      const description = option.description?.trim();
      return { optionId, label: option.label, ...(description ? { description } : {}) };
    });
    const sensitive = question.isSecret === true;
    const header = question.header?.trim();
    sets.push({
      setId,
      ...(header ? { header } : {}),
      prompt: question.question,
      selection: "single",
      options: mappedOptions,
      // The tool's own contract says the client adds a free-form "Other" to
      // every question, so free text is always on offer; with no options at
      // all — or a secret — it is the only answer.
      discussion: mappedOptions.length === 0 || sensitive ? "required" : "optional",
      ...(sensitive ? { sensitive: true } : {})
    });
    native.set(setId, { questionId: question.id, labelsByOptionId });
  }
  if (!isValidQuestionRequestBatch(sets)) {
    return { error: "request_user_input batch exceeds AgentRoom's question bounds" };
  }
  return { sets, native };
}

/**
 * The `item/tool/requestUserInput` response for a settled batch: each answered
 * question's chosen labels plus the person's free text, keyed by the agent's
 * own question id. Anything but a human answer is an empty map — the agent
 * reads every question as unanswered, which is the truth.
 */
export function codexUserInputResponse(
  batch: CodexUserInputBatch,
  outcome: QuestionWaitOutcome | { status: "unavailable" }
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (outcome.status !== "answered") return { answers };
  for (const answer of outcome.answers) {
    const nativeSet = batch.native.get(answer.setId);
    if (!nativeSet) continue;
    const labels = answer.selectedOptionIds
      .map((optionId) => nativeSet.labelsByOptionId.get(optionId))
      .filter((label): label is string => label !== undefined);
    const discussion = answer.discussion?.trim();
    const values = [...labels, ...(discussion ? [discussion] : [])];
    if (values.length > 0) answers[nativeSet.questionId] = { answers: values };
  }
  return { answers };
}
