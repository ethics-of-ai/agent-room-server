import { describe, expect, it } from "vitest";
import {
  QUESTION_TIMEOUT_RESPONSE,
  QUESTION_UNAVAILABLE_RESPONSE,
  askUserQuestionBatch,
  askUserQuestionUpdatedInput
} from "../src/runner/claudeCode/askUserQuestion";
import { MAX_QUESTION_PROMPT_LENGTH } from "../src/runner/shared/PendingQuestionRequests";

// The shape the bundled CLI (2.1.172) hands the SDK `canUseTool` callback for
// AskUserQuestion, as observed in the Phase 0 spike.
const toolInput = {
  questions: [
    {
      question: "What platform should the TODO app target first?",
      header: "Platform",
      options: [
        { label: "Web app", description: "Runs in the browser." },
        { label: "Mobile app", description: "Native iOS/Android." },
        { label: "CLI", description: "A terminal tool." }
      ],
      multiSelect: false
    },
    {
      question: "Which features should it include?",
      header: "Features",
      options: [
        { label: "Due dates", description: "Deadlines and reminders." },
        { label: "Tags", description: "Labels and categories." }
      ],
      multiSelect: true
    }
  ]
};

describe("AskUserQuestion mapping", () => {
  it("mints set and option ids and carries the CLI's question text and labels through", () => {
    const batch = askUserQuestionBatch(toolInput);
    if ("error" in batch) throw new Error(batch.error);
    expect(batch.sets).toEqual([
      {
        setId: "set-1",
        header: "Platform",
        prompt: "What platform should the TODO app target first?",
        selection: "single",
        options: [
          { optionId: "opt-1", label: "Web app", description: "Runs in the browser." },
          { optionId: "opt-2", label: "Mobile app", description: "Native iOS/Android." },
          { optionId: "opt-3", label: "CLI", description: "A terminal tool." }
        ],
        discussion: "optional"
      },
      {
        setId: "set-2",
        header: "Features",
        prompt: "Which features should it include?",
        selection: "multiple",
        options: [
          { optionId: "opt-1", label: "Due dates", description: "Deadlines and reminders." },
          { optionId: "opt-2", label: "Tags", description: "Labels and categories." }
        ],
        discussion: "optional"
      }
    ]);
  });

  it("writes a human answer back by question text, with notes beside each answer", () => {
    const batch = askUserQuestionBatch(toolInput);
    if ("error" in batch) throw new Error(batch.error);
    const updated = askUserQuestionUpdatedInput(toolInput, batch, {
      status: "answered",
      decidedBy: "human",
      answers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-2"] }
      ]
    });
    expect(updated).toEqual({
      ...toolInput,
      answers: {
        "What platform should the TODO app target first?": "Mobile app",
        "Which features should it include?": "Due dates, Tags"
      },
      annotations: {
        "What platform should the TODO app target first?": { notes: "phones first" }
      }
    });
  });

  it("uses the CLI's notes-only sentinel for free text without a choice and omits an unanswered question", () => {
    const batch = askUserQuestionBatch(toolInput);
    if ("error" in batch) throw new Error(batch.error);
    const updated = askUserQuestionUpdatedInput(toolInput, batch, {
      status: "answered",
      decidedBy: "human",
      answers: [{ setId: "set-1", selectedOptionIds: [], discussion: "neither — a watch app" }]
    });
    expect(updated.answers).toEqual({ "What platform should the TODO app target first?": "(notes only)" });
    expect(updated.annotations).toEqual({
      "What platform should the TODO app target first?": { notes: "neither — a watch app" }
    });
  });

  it("answers nothing on a timeout or an unpresentable batch and says why in response", () => {
    const batch = askUserQuestionBatch(toolInput);
    if ("error" in batch) throw new Error(batch.error);
    expect(askUserQuestionUpdatedInput(toolInput, batch, { status: "timeout", decidedBy: "timeout" })).toEqual({
      ...toolInput,
      answers: {},
      response: QUESTION_TIMEOUT_RESPONSE
    });
    expect(askUserQuestionUpdatedInput(toolInput, batch, { status: "unavailable" })).toEqual({
      ...toolInput,
      answers: {},
      response: QUESTION_UNAVAILABLE_RESPONSE
    });
  });

  it("refuses a batch outside the bounds rather than truncating its vocabulary", () => {
    expect(askUserQuestionBatch({})).toEqual({ error: "AskUserQuestion needs at least one question" });
    expect(
      askUserQuestionBatch({ questions: [{ question: "?", header: "H", options: [], multiSelect: false }] })
    ).toEqual({ error: "AskUserQuestion question 1 offers no options" });
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      question: `q${i}`,
      header: "H",
      options: [{ label: "a" }, { label: "b" }]
    }));
    expect(askUserQuestionBatch({ questions: tooMany })).toEqual({
      error: "AskUserQuestion accepts at most 8 questions per call"
    });
    expect(
      askUserQuestionBatch({
        questions: [{ question: "dup", options: [{ label: "a" }, { label: "a" }] }]
      })
    ).toEqual({ error: "AskUserQuestion option labels must be unique within a question" });
    expect(
      askUserQuestionBatch({
        questions: [{ question: "q".repeat(MAX_QUESTION_PROMPT_LENGTH + 1), options: [{ label: "a" }] }]
      })
    ).toEqual({ error: "AskUserQuestion batch exceeds AgentRoom's question bounds" });
  });
});
