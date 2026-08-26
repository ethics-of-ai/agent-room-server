import { describe, expect, it } from "vitest";
import {
  CURSOR_QUESTION_INPUT_SCHEMA,
  cursorQuestionBatch
} from "../src/runner/cursor/questions";

describe("Cursor clarifying-question vocabulary", () => {
  it("advertises and maps selection, discussion, free-text-only, and sensitive sets", () => {
    const questionItems = (
      (
        (CURSOR_QUESTION_INPUT_SCHEMA.properties as Record<string, unknown>).questions as {
          items: { properties: Record<string, unknown> };
        }
      ).items.properties
    );
    expect(questionItems).toHaveProperty("selection");
    expect(questionItems).toHaveProperty("discussion");
    expect(questionItems).toHaveProperty("sensitive");

    const batch = cursorQuestionBatch({
      questions: [
        {
          header: "Targets",
          question: "Which clients?",
          selection: "multiple",
          options: [{ label: "macOS" }, { label: "visionOS" }],
          discussion: "none"
        },
        {
          question: "Paste the private value",
          selection: "single",
          options: [],
          discussion: "required",
          sensitive: true
        }
      ]
    });

    if ("error" in batch) throw new Error(batch.error);
    expect(batch.sets).toEqual([
      {
        setId: "set-1",
        header: "Targets",
        prompt: "Which clients?",
        selection: "multiple",
        options: [
          { optionId: "opt-1", label: "macOS" },
          { optionId: "opt-2", label: "visionOS" }
        ],
        discussion: "none"
      },
      {
        setId: "set-2",
        prompt: "Paste the private value",
        selection: "single",
        options: [],
        discussion: "required",
        sensitive: true
      }
    ]);
  });

  it("refuses an optionless set unless free text is required", () => {
    expect(cursorQuestionBatch({
      questions: [{ question: "Unanswerable", selection: "single", options: [], discussion: "optional" }]
    })).toEqual({ error: "ask_user_question question 1 offers no answer path" });
  });
});
