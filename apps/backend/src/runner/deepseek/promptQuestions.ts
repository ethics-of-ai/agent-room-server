import { z } from "zod";
import type { CanonicalQuestionSet } from "../AgentRunner";
import {
  MAX_QUESTION_DESCRIPTION_LENGTH,
  MAX_QUESTION_HEADER_LENGTH,
  MAX_QUESTION_LABEL_LENGTH,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_PROMPT_LENGTH,
  MAX_QUESTION_SETS,
  isAnswerableQuestionSet,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";

/**
 * DeepSeek Harness has no server-to-client request on its SDK wire. This
 * standing prompt gives it a narrow in-band equivalent: one line-anchored JSON
 * block in assistant text. The adapter parses the block, keeps it out of the
 * transcript, and sends the person's answer as a second SDK prompt while the
 * same AgentRoom turn remains open.
 */
export const DEEPSEEK_QUESTION_PROMPT_INSTRUCTION = [
  "Clarifying questions: when a missing user decision prevents useful progress, ask through AgentRoom instead of guessing.",
  "End your response with a line containing <agentroom-question>, followed by one JSON object and a closing </agentroom-question> line.",
  'The JSON shape is {"sets":[{"header":"Short label","prompt":"Question","selection":"single|multiple","options":[{"label":"Choice","description":"Tradeoff"}],"discussion":"none|optional|required","sensitive":false}]}.',
  `Emit 1-${MAX_QUESTION_SETS} sets and at most ${MAX_QUESTION_OPTIONS} options per set.`,
  "Use an empty options array only with required discussion. Emit at most one block, never wrap an example, and write nothing after the closing tag.",
  "AgentRoom will send the user's answer as the next Harness prompt and keep it in this same AgentRoom turn."
].join(" ");

const OPEN_TAG = "<agentroom-question>";
const CLOSE_PREFIX = "</agentroom-question";
// Large enough for the canonical field caps, small enough that malformed model
// output cannot turn this parser into an unbounded transcript buffer.
const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_CLOSE_CARRY = 64;

const promptOptionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_QUESTION_LABEL_LENGTH),
  description: z.string().trim().min(1).max(MAX_QUESTION_DESCRIPTION_LENGTH).optional()
});

const promptSetSchema = z.object({
  header: z.string().trim().min(1).max(MAX_QUESTION_HEADER_LENGTH).optional(),
  prompt: z.string().trim().min(1).max(MAX_QUESTION_PROMPT_LENGTH),
  selection: z.enum(["single", "multiple"]),
  options: z.array(promptOptionSchema).max(MAX_QUESTION_OPTIONS),
  discussion: z.enum(["none", "optional", "required"]),
  sensitive: z.boolean().optional()
});

const promptBatchSchema = z.object({
  sets: z.array(promptSetSchema).min(1).max(MAX_QUESTION_SETS)
});

export interface DeepSeekPromptQuestionBatch {
  sets: CanonicalQuestionSet[];
}

export interface DeepSeekPromptQuestionStreamResult {
  prose: string;
  batch?: DeepSeekPromptQuestionBatch;
}

/**
 * Parse one complete prompt-contract JSON body into the canonical question
 * vocabulary. Set and option ids are minted here, never accepted from model
 * output, so a client answer cannot feed a model-authored id back to the agent.
 */
export function deepseekPromptQuestionBatch(body: string): DeepSeekPromptQuestionBatch | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = promptBatchSchema.safeParse(value);
  if (!parsed.success) return undefined;

  const sets: CanonicalQuestionSet[] = [];
  for (const [setIndex, source] of parsed.data.sets.entries()) {
    const seenLabels = new Set<string>();
    const options: CanonicalQuestionSet["options"] = [];
    for (const [optionIndex, option] of source.options.entries()) {
      if (seenLabels.has(option.label)) return undefined;
      seenLabels.add(option.label);
      options.push({
        optionId: `opt-${optionIndex + 1}`,
        label: option.label,
        ...(option.description ? { description: option.description } : {})
      });
    }
    const set: CanonicalQuestionSet = {
      setId: `set-${setIndex + 1}`,
      ...(source.header ? { header: source.header } : {}),
      prompt: source.prompt,
      selection: source.selection,
      options,
      discussion: source.discussion,
      ...(source.sensitive ? { sensitive: true } : {})
    };
    if (!isAnswerableQuestionSet(set)) return undefined;
    sets.push(set);
  }
  return { sets };
}

/**
 * Streaming, line-anchored parser for DeepSeek's prompt-contract question
 * block. A valid block is removed from prose. An invalid, incomplete, or
 * over-cap block is returned verbatim, so model variability never silently
 * eats the assistant's response. At most one valid batch is recognized per
 * Harness turn.
 */
export class DeepSeekPromptQuestionStreamParser {
  private state: "outside" | "inside" | "done" = "outside";
  private carry = "";
  private body = "";
  private bodyBytes = 0;
  private atLineStart = true;

  push(delta: string): DeepSeekPromptQuestionStreamResult {
    if (this.state === "done") {
      this.atLineStart = lineStartAfter(this.atLineStart, delta);
      return { prose: delta };
    }

    let work = this.carry + delta;
    this.carry = "";
    let prose = "";
    let batch: DeepSeekPromptQuestionBatch | undefined;

    const emitProse = (text: string): void => {
      if (!text) return;
      prose += text;
      this.atLineStart = lineStartAfter(this.atLineStart, text);
    };

    while (work.length > 0) {
      if (this.state === "outside") {
        const start = this.findOpen(work);
        if (start >= 0) {
          emitProse(work.slice(0, start));
          work = work.slice(start + OPEN_TAG.length);
          this.body = "";
          this.bodyBytes = 0;
          this.state = "inside";
          continue;
        }

        const held = suffixPrefixLength(work, OPEN_TAG);
        if (held > 0 && this.candidateAtLineStart(work, work.length - held)) {
          emitProse(work.slice(0, work.length - held));
          this.carry = work.slice(work.length - held);
        } else {
          emitProse(work);
        }
        break;
      }

      const close = findClose(work);
      if (close.kind === "found") {
        const body = this.body + work.slice(0, close.start);
        const raw = OPEN_TAG + body + work.slice(close.start, close.end);
        if (this.bodyBytes + Buffer.byteLength(work.slice(0, close.start), "utf8") <= MAX_BLOCK_BYTES) {
          batch = deepseekPromptQuestionBatch(body);
        }
        work = work.slice(close.end);
        this.body = "";
        this.bodyBytes = 0;
        if (batch) {
          // The contract permits one batch. Everything after it is ordinary
          // prose, including a second tag the model should not have emitted.
          this.state = "done";
          emitProse(work);
          break;
        }
        // Invalid JSON or vocabulary is visible rather than silently consumed.
        emitProse(raw);
        this.state = "outside";
        continue;
      }

      let holdStart = close.kind === "partial" ? close.start : work.length;
      if (work.length - holdStart > MAX_CLOSE_CARRY) holdStart = work.length;
      const bodyChunk = work.slice(0, holdStart);
      const bodyChunkBytes = Buffer.byteLength(bodyChunk, "utf8");
      if (this.bodyBytes + bodyChunkBytes > MAX_BLOCK_BYTES) {
        // Stop recognizing blocks for this turn and release everything held so
        // far. Later deltas pass through directly, keeping memory bounded.
        const raw = OPEN_TAG + this.body + work;
        this.body = "";
        this.bodyBytes = 0;
        this.carry = "";
        this.state = "done";
        emitProse(raw);
        break;
      }
      this.body += bodyChunk;
      this.bodyBytes += bodyChunkBytes;
      this.carry = work.slice(holdStart);
      break;
    }

    return { prose, ...(batch ? { batch } : {}) };
  }

  flush(): DeepSeekPromptQuestionStreamResult {
    let prose = "";
    if (this.state === "inside") {
      // An unterminated control block is malformed prose, not a question.
      prose = OPEN_TAG + this.body + this.carry;
    } else if (this.state === "outside") {
      prose = this.carry;
    }
    this.state = "done";
    this.body = "";
    this.bodyBytes = 0;
    this.carry = "";
    this.atLineStart = true;
    return { prose };
  }

  private findOpen(work: string): number {
    let from = 0;
    for (;;) {
      const index = work.indexOf(OPEN_TAG, from);
      if (index < 0) return -1;
      if (this.candidateAtLineStart(work, index)) return index;
      from = index + OPEN_TAG.length;
    }
  }

  private candidateAtLineStart(work: string, index: number): boolean {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const char = work[cursor];
      if (char === "\n" || char === "\r") return true;
      if (char !== " " && char !== "\t") return false;
    }
    return this.atLineStart;
  }
}

/**
 * Model-visible continuation for the second Harness prompt. It contains labels
 * and the person's own words, never AgentRoom ids. Omitted sets remain visibly
 * unanswered, and timeout never selects a default on the person's behalf.
 */
export function deepseekQuestionFollowUp(
  batch: DeepSeekPromptQuestionBatch,
  outcome: Exclude<QuestionWaitOutcome, { status: "cancelled" }> | { status: "unavailable" }
): string {
  if (outcome.status !== "answered") {
    return outcome.status === "timeout"
      ? "No answer arrived for your AgentRoom clarifying questions in time. Continue the original task with your best judgment and state the assumptions you made."
      : "AgentRoom could not present your clarifying questions. Continue the original task with your best judgment and state the assumptions you made.";
  }

  const answersBySet = new Map(outcome.answers.map((answer) => [answer.setId, answer] as const));
  const answers = batch.sets.map((set) => {
    const answer = answersBySet.get(set.setId);
    const labelsById = new Map(set.options.map((option) => [option.optionId, option.label] as const));
    return {
      ...(set.header ? { header: set.header } : {}),
      prompt: set.prompt,
      selected: answer?.selectedOptionIds
        .map((optionId) => labelsById.get(optionId))
        .filter((label): label is string => label !== undefined) ?? [],
      ...(answer?.discussion?.trim() ? { discussion: answer.discussion } : {}),
      answered: Boolean(answer)
    };
  });
  return [
    "The user answered your AgentRoom clarifying questions. Continue the original task using these answers. Omitted sets are unanswered; do not invent a choice for them.",
    JSON.stringify({ answers })
  ].join("\n");
}

type CloseScan =
  | { kind: "found"; start: number; end: number }
  | { kind: "partial"; start: number }
  | { kind: "none" };

function findClose(work: string): CloseScan {
  const lower = work.toLowerCase();
  let from = 0;
  for (;;) {
    const index = lower.indexOf(CLOSE_PREFIX, from);
    if (index < 0) {
      const held = suffixPrefixLength(lower, CLOSE_PREFIX);
      return held > 0 ? { kind: "partial", start: work.length - held } : { kind: "none" };
    }
    let cursor = index + CLOSE_PREFIX.length;
    while (cursor < work.length && isWhitespace(work[cursor])) cursor += 1;
    if (cursor >= work.length) return { kind: "partial", start: index };
    if (work[cursor] === ">") return { kind: "found", start: index, end: cursor + 1 };
    from = index + CLOSE_PREFIX.length;
  }
}

function suffixPrefixLength(value: string, prefix: string): number {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) return length;
  }
  return 0;
}

function lineStartAfter(initial: boolean, text: string): boolean {
  let lineStart = initial;
  for (const char of text) {
    if (char === "\n" || char === "\r") lineStart = true;
    else if (char !== " " && char !== "\t") lineStart = false;
  }
  return lineStart;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
