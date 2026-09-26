import { MAX_QUESTION_OPTIONS, MAX_QUESTION_SETS } from "../runner/shared/PendingQuestionRequests";
import { registerAgentTool } from "./catalog";

/**
 * The `questions.ask` AgentRoom tool: the catalog shape of the clarifying-
 * question channel every runner already exposes through its own mechanism.
 *
 * The input is AgentRoom's shared question vocabulary — the same bounds the
 * pending store enforces — so the model cannot offer more sets or options than
 * the wait accepts. The adapter's mapper remains the canonical validator; the
 * schema advertised here is checked against it by
 * `apps/backend/test/agentTools.test.ts` so the two cannot drift.
 *
 * The model-facing name preserves Cursor's native `ask_user_question`: the
 * first transport registered this tool under that name and the model has seen
 * it in every session since. A second runner maps its own native question
 * entry onto this logical id instead of registering a duplicate tool beside it.
 */

export const QUESTIONS_ASK_LOGICAL_ID = "questions.ask";

/** The native name of the first transport; kept as the model-facing entry. */
export const QUESTIONS_ASK_NAME = "ask_user_question";

export const QUESTIONS_ASK_DESCRIPTION =
  "Ask the person driving this session one or more bounded questions and wait for their answer. " +
  "Use it only when a missing decision blocks useful progress; otherwise proceed and state your assumptions.";

/** What the model reads when the batch could not be held open at all. */
export const QUESTIONS_ASK_UNAVAILABLE_RESULT =
  "These questions could not be put to the person right now. Proceed with your best judgment and state the assumptions you made.";

/**
 * The JSON Schema the host advertises as the tool's `inputSchema`. Kept in the
 * shared vocabulary's bounds so the model cannot offer more sets or options
 * than the wait accepts.
 */
export const QUESTIONS_ASK_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTION_SETS,
      items: {
        type: "object",
        properties: {
          header: { type: "string", description: "A short chip label for the question." },
          question: { type: "string", description: "The question to put to the person." },
          selection: {
            type: "string",
            enum: ["single", "multiple"],
            description: "Whether one or several offered options may be chosen."
          },
          options: {
            type: "array",
            minItems: 0,
            maxItems: MAX_QUESTION_OPTIONS,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" }
              },
              required: ["label"]
            }
          },
          discussion: {
            type: "string",
            enum: ["none", "optional", "required"],
            description: "Whether the person may or must answer with free text."
          },
          sensitive: {
            type: "boolean",
            description: "Whether free text must stay out of events, transcript, audit, and logs."
          }
        },
        required: ["question", "selection", "options", "discussion"]
      }
    }
  },
  required: ["questions"]
};

export const questionsAskDefinition = {
  logicalId: QUESTIONS_ASK_LOGICAL_ID,
  name: QUESTIONS_ASK_NAME,
  description: QUESTIONS_ASK_DESCRIPTION,
  inputSchema: QUESTIONS_ASK_INPUT_SCHEMA,
  outputSchema: { type: "string", maxLength: 64 * 1024 },
  unavailableResult: QUESTIONS_ASK_UNAVAILABLE_RESULT,
  requiredCapability: "questions" as const,
  gate: "clarifyingQuestions" as const
};

registerAgentTool(questionsAskDefinition);
