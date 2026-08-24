import { describe, expect, it } from "vitest";
import {
  DeepSeekPromptQuestionStreamParser,
  deepseekPromptQuestionBatch,
  deepseekQuestionFollowUp
} from "../src/runner/deepseek/promptQuestions";

const body = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  sets: [
    {
      header: "Target",
      prompt: "Which client should land first?",
      selection: "single",
      options: [
        { label: "visionOS", description: "Ship the spatial client first" },
        { label: "macOS", description: "Ship the operator app first" }
      ],
      discussion: "optional",
      ...overrides
    }
  ]
});

function parse(deltas: string[]): { prose: string; batches: NonNullable<ReturnType<DeepSeekPromptQuestionStreamParser["push"]>["batch"]>[] } {
  const parser = new DeepSeekPromptQuestionStreamParser();
  let prose = "";
  const batches: NonNullable<ReturnType<DeepSeekPromptQuestionStreamParser["push"]>["batch"]>[] = [];
  for (const delta of deltas) {
    const result = parser.push(delta);
    prose += result.prose;
    if (result.batch) batches.push(result.batch);
  }
  prose += parser.flush().prose;
  return { prose, batches };
}

describe("DeepSeek prompt-contract questions", () => {
  it("maps bounded model JSON into AgentRoom-minted set and option ids", () => {
    expect(deepseekPromptQuestionBatch(body())).toEqual({
      sets: [
        {
          setId: "set-1",
          header: "Target",
          prompt: "Which client should land first?",
          selection: "single",
          options: [
            { optionId: "opt-1", label: "visionOS", description: "Ship the spatial client first" },
            { optionId: "opt-2", label: "macOS", description: "Ship the operator app first" }
          ],
          discussion: "optional"
        }
      ]
    });
  });

  it("rejects an unanswerable set and duplicate labels as whole batches", () => {
    expect(deepseekPromptQuestionBatch(body({ options: [], discussion: "none" }))).toBeUndefined();
    expect(deepseekPromptQuestionBatch(body({
      options: [{ label: "same" }, { label: "same" }]
    }))).toBeUndefined();
  });

  it("extracts a line-start block split across deltas and keeps surrounding prose", () => {
    const raw = body();
    const result = parse([
      "I need one decision.\n<agentroom-que",
      `stion>${raw.slice(0, 40)}`,
      `${raw.slice(40)}</agentroom-ques`,
      "tion>"
    ]);

    expect(result.prose).toBe("I need one decision.\n");
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].sets[0].prompt).toBe("Which client should land first?");
  });

  it("leaves inline, invalid, and unterminated blocks visible as prose", () => {
    const inline = `Example: <agentroom-question>${body()}</agentroom-question>`;
    expect(parse([inline])).toEqual({ prose: inline, batches: [] });

    const invalid = "<agentroom-question>{bad json}</agentroom-question>";
    expect(parse([invalid])).toEqual({ prose: invalid, batches: [] });

    const unfinished = `<agentroom-question>${body()}`;
    expect(parse([unfinished])).toEqual({ prose: unfinished, batches: [] });
  });

  it("releases an oversized block as prose instead of buffering or parsing it", () => {
    const oversized = `<agentroom-question>${body({
      prompt: "x".repeat(70 * 1024)
    })}</agentroom-question>`;

    expect(parse([oversized])).toEqual({ prose: oversized, batches: [] });
  });

  it("recognizes at most one valid batch per Harness turn", () => {
    const block = `<agentroom-question>${body()}</agentroom-question>`;
    const result = parse([`${block}\n${block}`]);
    expect(result.batches).toHaveLength(1);
    expect(result.prose).toBe(`\n${block}`);
  });

  it("renders selected labels and discussion for the follow-up prompt without AgentRoom ids", () => {
    const batch = deepseekPromptQuestionBatch(body())!;
    const followUp = deepseekQuestionFollowUp(batch, {
      status: "answered",
      decidedBy: "human",
      answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"], discussion: "Headset workflow first" }]
    });

    expect(followUp).toContain("visionOS");
    expect(followUp).toContain("Headset workflow first");
    expect(followUp).not.toContain("set-1");
    expect(followUp).not.toContain("opt-1");
  });

  it("reports timeout without selecting a default", () => {
    const batch = deepseekPromptQuestionBatch(body())!;
    const followUp = deepseekQuestionFollowUp(batch, { status: "timeout", decidedBy: "timeout" });
    expect(followUp).toContain("No answer arrived");
    expect(followUp).toContain("best judgment");
    expect(followUp).not.toContain("visionOS");
  });
});
