import { describe, expect, it } from "vitest";
import { PendingRequests } from "../src/runner/shared/PendingRequests";
import {
  MAX_QUESTION_PROMPT_LENGTH,
  PendingQuestionRequests,
  isValidQuestionRequestBatch,
  validateQuestionAnswers,
  type QuestionRequestSet
} from "../src/runner/shared/PendingQuestionRequests";

const sets: QuestionRequestSet[] = [
  {
    setId: "set-1",
    header: "Platform",
    prompt: "Which platform first?",
    selection: "single",
    options: [
      { optionId: "opt-1", label: "Web" },
      { optionId: "opt-2", label: "Mobile", description: "iOS and Android" }
    ],
    discussion: "optional"
  },
  {
    setId: "set-2",
    header: "Features",
    prompt: "Which features matter?",
    selection: "multiple",
    options: [
      { optionId: "opt-1", label: "Reminders" },
      { optionId: "opt-2", label: "Tags" },
      { optionId: "opt-3", label: "Sharing" }
    ],
    discussion: "none"
  },
  {
    setId: "set-3",
    prompt: "Anything else?",
    selection: "single",
    options: [],
    discussion: "required"
  }
];

describe("pending question requests", () => {
  it("settles with the answers a human submitted, trimming nothing and keeping ids exact", async () => {
    const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
    const wait = pending.wait({ sessionKey: "s1", requestId: "q1", sets })!;

    expect(
      pending.answer("s1", "q1", [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "  because phones  " },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        // set-3 deliberately unanswered
      ])
    ).toBe("answered");
    await expect(wait).resolves.toEqual({
      status: "answered",
      decidedBy: "human",
      answers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "  because phones  " },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
      ]
    });
    expect(pending.pendingCount("s1")).toBe(0);
    expect(pending.answer("s1", "q1", [])).toBe("unknown_request");
  });

  it("refuses a set or option the agent did not offer, and a second choice on a single set", () => {
    expect(validateQuestionAnswers(sets, [{ setId: "set-9", selectedOptionIds: [] }])).toBe("unknown_set");
    expect(validateQuestionAnswers(sets, [{ setId: "set-1", selectedOptionIds: ["opt-9"] }])).toBe("unknown_option");
    expect(validateQuestionAnswers(sets, [{ setId: "set-1", selectedOptionIds: ["opt-1", "opt-2"] }])).toBe(
      "selection_limit"
    );
    expect(validateQuestionAnswers(sets, [{ setId: "set-2", selectedOptionIds: ["opt-1", "opt-1"] }])).toBe(
      "duplicate_option"
    );
    expect(
      validateQuestionAnswers(sets, [
        { setId: "set-1", selectedOptionIds: ["opt-1"] },
        { setId: "set-1", selectedOptionIds: ["opt-2"] }
      ])
    ).toBe("duplicate_set");
  });

  it("accepts free text only where the set offered it, and never an empty entry", () => {
    // `discussion: "none"` — the agent invited no free text here.
    expect(validateQuestionAnswers(sets, [{ setId: "set-2", selectedOptionIds: ["opt-1"], discussion: "but" }])).toBe(
      "discussion_not_offered"
    );
    // A free-text-only set is answered by its text alone.
    expect(validateQuestionAnswers(sets, [{ setId: "set-3", selectedOptionIds: [], discussion: "ship it" }])).toBe(
      "answered"
    );
    // Naming a set without answering it is refused; omitting it is how a set is skipped.
    expect(validateQuestionAnswers(sets, [{ setId: "set-1", selectedOptionIds: [], discussion: "   " }])).toBe(
      "empty_answer"
    );
    expect(validateQuestionAnswers(sets, [])).toBe("empty_batch");
    expect(
      validateQuestionAnswers(
        [{ ...sets[0], discussion: "required" }],
        [{ setId: "set-1", selectedOptionIds: ["opt-1"] }]
      )
    ).toBe("discussion_required");
  });

  it("refuses the wait itself when a set cannot be answered or the batch is empty", () => {
    const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
    expect(pending.wait({ sessionKey: "s1", requestId: "q1", sets: [] })).toBeUndefined();
    expect(
      pending.wait({
        sessionKey: "s1",
        requestId: "q1",
        sets: [{ setId: "set-1", prompt: "?", selection: "single", options: [], discussion: "optional" }]
      })
    ).toBeUndefined();
    expect(pending.pendingCount("s1")).toBe(0);
  });

  it("refuses duplicate ids and model-authored text outside the shared bounds", () => {
    const duplicateSetIds = [sets[0], { ...sets[1], setId: sets[0].setId }];
    expect(isValidQuestionRequestBatch(duplicateSetIds)).toBe(false);
    expect(isValidQuestionRequestBatch([{ ...sets[0], options: [sets[0].options[0], sets[0].options[0]] }])).toBe(false);
    expect(isValidQuestionRequestBatch([{ ...sets[0], prompt: "x".repeat(MAX_QUESTION_PROMPT_LENGTH + 1) }])).toBe(false);

    const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
    expect(pending.wait({ sessionKey: "s1", requestId: "q1", sets: duplicateSetIds })).toBeUndefined();
    expect(pending.pendingCount("s1")).toBe(0);
  });

  it("reports a timeout as a timeout and a release as cancelled, never as a choice", async () => {
    const pending = new PendingQuestionRequests({ timeoutMs: 20 });
    const timedOut = pending.wait({ sessionKey: "s1", requestId: "q1", sets })!;
    await expect(timedOut).resolves.toEqual({ status: "timeout", decidedBy: "timeout" });

    const slow = new PendingQuestionRequests({ timeoutMs: 5_000 });
    const cancelled = slow.wait({ sessionKey: "s1", requestId: "q2", sets })!;
    expect(slow.cancel("s1", "q2")).toBe(true);
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    expect(slow.cancel("s1", "q2")).toBe(false);

    const released = slow.wait({ sessionKey: "s1", requestId: "q3", sets })!;
    slow.releaseSession("s1");
    await expect(released).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps sessions apart and caps how many batches one session holds", async () => {
    const pending = new PendingQuestionRequests({ timeoutMs: 5_000, maxPerSession: 2 });
    const first = pending.wait({ sessionKey: "s1", requestId: "q1", sets })!;
    const second = pending.wait({ sessionKey: "s1", requestId: "q2", sets })!;
    expect(pending.wait({ sessionKey: "s1", requestId: "q3", sets })).toBeUndefined();
    // A duplicate id never replaces a live wait.
    expect(pending.wait({ sessionKey: "s1", requestId: "q1", sets })).toBeUndefined();
    expect(pending.answer("s2", "q1", [{ setId: "set-1", selectedOptionIds: ["opt-1"] }])).toBe("unknown_request");

    pending.releaseAll();
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toEqual({ status: "cancelled" });
  });

  it("exposes the held sets for a late-joining client", () => {
    const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
    pending.wait({ sessionKey: "s1", requestId: "q1", sets });
    expect(pending.outstanding("s1", "q1")).toEqual(sets);
    expect(pending.outstanding("s1", "missing")).toBeUndefined();
    pending.releaseAll();
  });
});

describe("pending requests core", () => {
  it("settles through its own entry table and releases per session", async () => {
    const core = new PendingRequests<{ n: number }, string>({
      timeoutMs: 5_000,
      maxPerSession: 8,
      onTimeout: (entry) => `timeout:${entry.n}`,
      onRelease: (entry) => `release:${entry.n}`
    });
    const a = core.open("s1", "r1", { n: 1 })!;
    const b = core.open("s1", "r2", { n: 2 })!;
    const other = core.open("s2", "r1", { n: 3 })!;
    expect(core.entry("s1", "r1")).toEqual({ n: 1 });
    expect(core.settle("s1", "r1", "done")).toBe(true);
    expect(core.settle("s1", "r1", "again")).toBe(false);
    core.releaseSession("s1");
    await expect(a).resolves.toBe("done");
    await expect(b).resolves.toBe("release:2");
    expect(core.pendingCount("s2")).toBe(1);
    core.releaseAll();
    await expect(other).resolves.toBe("release:3");
  });
});
