import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { agentToolByLogicalId } from "../src/agentTools/catalog";
import { SessionQuestionChannel } from "../src/agent/SessionQuestionChannel";
import { CHILD_TOOLS_UNAVAILABLE_RESULT } from "../src/children/agent/childToolContract";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerInput } from "../src/runner/AgentRunner";
import {
  MAX_QUESTION_HEADER_LENGTH,
  MAX_QUESTION_LABEL_LENGTH,
  MAX_QUESTION_PROMPT_LENGTH,
  MAX_QUESTION_SETS
} from "../src/runner/shared/PendingQuestionRequests";
import { buildServer } from "../src/server";
import { config, createGitWorkspace, git } from "./support/agentSessionHarness";

// The worktree offer card against a real server and real temporary
// repositories. A held parent turn keeps its tools live; each test calls
// agentroom_child_start the way an adapter relays a model's call and answers
// the card through the ordinary question route, as a client would.

const slow = 30_000;
const START = agentToolByLogicalId("children.start")!.name;

interface QuestionEvent {
  sessionId: string;
  turnId: string;
  requestId?: string;
  questionSets: Array<{
    setId: string;
    header?: string;
    prompt: string;
    selection: string;
    discussion: string;
    options: Array<{ optionId: string; label: string; description?: string }>;
  }>;
}

function heldRunner() {
  const inputs: AgentRunnerInput[] = [];
  const gates = new Map<string, () => void>();
  const state = { hold: (_input: AgentRunnerInput) => false };
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      inputs.push(input);
      if (state.hold(input)) await new Promise<void>((resolve) => gates.set(input.runId, resolve));
      yield { type: "run_succeeded", message: "Done" };
    },
    async cancel(runId) {
      gates.get(runId)?.();
    }
  };
  return Object.assign(state, {
    runner,
    inputsOf: (sessionId: string) => inputs.filter((input) => input.sessionId === sessionId),
    release(runId: string) {
      gates.get(runId)?.();
      gates.delete(runId);
    }
  });
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

async function offerStack(configOverrides: Partial<ServiceConfig> = {}) {
  const fake = heldRunner();
  const built = await buildServer({ config: await config({ runnerKind: "claude_code", ...configOverrides }), runners: { claude_code: fake.runner } });
  closers.push(() => built.app.close());
  const { app } = built;
  const questions: QuestionEvent[] = [];
  const changes: Array<{ change: string; initiation?: string; childSessionId: string }> = [];
  built.eventBus.subscribe((event) => {
    if (event.type === "coding_question_requested") questions.push(event.payload as QuestionEvent);
    if (event.type === "agent_child_changed") changes.push(event.payload as (typeof changes)[number]);
  });
  const workspacePath = await createGitWorkspace();
  const workspace = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspacePath } })).json().workspace as LocalWorkspace;
  const parentId = (await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, title: "Parent", runnerKind: "claude_code" } }))
    .json().session.id as string;
  const holdParentTurn = async () => {
    fake.hold = (input) => input.sessionId === parentId;
    const before = fake.inputsOf(parentId).length;
    expect((await app.inject({ method: "POST", url: `/api/agent-sessions/${parentId}/turns`, payload: { message: "Three fixes, please." } })).statusCode).toBe(202);
    await until(() => fake.inputsOf(parentId).length > before);
    fake.hold = () => false;
    return fake.inputsOf(parentId).at(-1)!;
  };
  /** Starts a call without waiting for it; the raw text, since a call that outlives its turn is not JSON. */
  const startCall = (turn: AgentRunnerInput, args: unknown, signal = new AbortController().signal) =>
    turn.tools!.binding.invoke({ callId: `call-${Math.random()}`, name: START, arguments: args, signal });
  const nextQuestion = async (seen: number) => {
    await until(() => questions.length > seen);
    return questions[seen]!;
  };
  const answer = async (question: QuestionEvent, choices: Record<string, string>) => {
    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${parentId}/questions/${question.requestId}`,
      payload: { answers: Object.entries(choices).map(([setId, optionId]) => ({ setId, selectedOptionIds: [optionId] })) }
    });
    expect(answered.statusCode).toBe(200);
  };
  const children = () => built.agentSessions.listSessions().filter((session) => session.parent?.sessionId === parentId);
  const headCommit = async () => (await git(workspacePath, "rev-parse", "HEAD")).trim();
  return { ...built, fake, questions, changes, parentId, holdParentTurn, startCall, nextQuestion, answer, children, headCommit };
}

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, task: `Do ${title}.`, reason: "It touches other files.", ...extra });

describe("worktree offer card", () => {
  it("asks one set per task within the question limits, naming the title, the reason and the short base commit", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const longTitle = "T".repeat(120);
    const longReason = "R".repeat(500);
    const tasks = [task(longTitle, { reason: longReason }), task("Fix the docs"), task("Fix the flag"), task("Fix the tests")];
    const pending = stack.startCall(turn, { tasks, operationId: "op-shape" });
    const question = await stack.nextQuestion(0);

    expect(question.turnId).toBe(turn.runId);
    expect(question.questionSets.length).toBeLessThanOrEqual(MAX_QUESTION_SETS);
    expect(question.questionSets.map((set) => set.setId)).toEqual(["task-0", "task-1", "task-2", "task-3"]);
    const short = (await stack.headCommit()).slice(0, 7);
    for (const [index, set] of question.questionSets.entries()) {
      expect(set).toMatchObject({
        header: "Worktree?",
        selection: "single",
        discussion: "none",
        options: [{ optionId: "worktree", label: "New worktree thread" }, { optionId: "here", label: "Do it here" }]
      });
      expect(set.header!.length).toBeLessThanOrEqual(MAX_QUESTION_HEADER_LENGTH);
      expect(set.prompt.length).toBeLessThanOrEqual(MAX_QUESTION_PROMPT_LENGTH);
      for (const option of set.options) expect(option.label.length).toBeLessThanOrEqual(MAX_QUESTION_LABEL_LENGTH);
      expect(set.prompt).toContain(`"${tasks[index]!.title}"`);
      expect(set.prompt).toContain(tasks[index]!.reason);
      expect(set.prompt).toContain(`commit ${short},`);
    }
    expect(question.questionSets[1]!.prompt).toBe(
      `The agent wants to hand "Fix the docs" to a new child thread. It would work in its own worktree, on a new branch from commit ${short}, ` +
      "without this thread's uncommitted changes. The agent's reason: It touches other files."
    );
    // Nothing exists before the person answers.
    expect(stack.children()).toHaveLength(0);

    await stack.answer(question, { "task-0": "here", "task-1": "here", "task-2": "here", "task-3": "here" });
    const result = JSON.parse(await pending);
    expect(result.tasks.map((entry: { outcome: string }) => entry.outcome)).toEqual(["do_here", "do_here", "do_here", "do_here"]);
    stack.fake.release(turn.runId);
  }, slow);

  it("creates a child per task answered New worktree thread and returns do_here for the rest", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const pending = stack.startCall(turn, { tasks: [task("Fix the flag"), task("Fix the docs"), task("Fix the tests")], operationId: "op-mixed" });
    const question = await stack.nextQuestion(0);
    await stack.answer(question, { "task-0": "worktree", "task-1": "here", "task-2": "worktree" });

    const result = JSON.parse(await pending);
    expect(result).toMatchObject({ ok: true, operationId: "op-mixed" });
    expect(result.tasks.map((entry: { title: string; outcome: string }) => [entry.title, entry.outcome]))
      .toEqual([["Fix the flag", "created"], ["Fix the docs", "do_here"], ["Fix the tests", "created"]]);
    expect(stack.children().map((child) => [child.title, child.parent?.operationId]).sort())
      .toEqual([["Fix the flag", "op-mixed:0"], ["Fix the tests", "op-mixed:2"]]);
    expect(stack.changes.map((change) => [change.change, change.initiation])).toEqual([["created", "offer"], ["created", "offer"]]);
    stack.fake.release(turn.runId);
  }, slow);

  it("reports a set the person left blank as unanswered for that task only", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const pending = stack.startCall(turn, { tasks: [task("Fix the flag"), task("Fix the docs")], operationId: "op-blank" });
    await stack.answer(await stack.nextQuestion(0), { "task-0": "here" });

    const result = JSON.parse(await pending);
    expect(result.tasks).toEqual([
      { title: "Fix the flag", outcome: "do_here" },
      { title: "Fix the docs", outcome: "refused", code: "unanswered", message: expect.stringContaining("left this task blank") }
    ]);
    expect(stack.children()).toHaveLength(0);
    stack.fake.release(turn.runId);
  }, slow);

  it("replays a mixed answer without asking twice", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const input = { tasks: [task("Fix the flag"), task("Fix the docs")], operationId: "op-replay" };
    const first = stack.startCall(turn, input);
    await stack.answer(await stack.nextQuestion(0), { "task-0": "worktree", "task-1": "here" });
    const answered = JSON.parse(await first);

    const replay = JSON.parse(await stack.startCall(turn, input));
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(replay.tasks.map((entry: { outcome: string }) => entry.outcome)).toEqual(["created", "do_here"]);
    expect(replay.tasks[0].child.sessionId).toBe(answered.tasks[0].child.sessionId);
    expect(stack.questions).toHaveLength(1);
    expect(stack.children()).toHaveLength(1);
    stack.fake.release(turn.runId);
  }, slow);

  it("returns unanswered after a timeout, creates nothing, and a replay does not ask again", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    // The ten-minute clock, run out: the channel answers as its timer would.
    const ask = vi.spyOn(SessionQuestionChannel.prototype, "ask").mockResolvedValue({ status: "timeout", decidedBy: "timeout" });
    const input = { tasks: [task("Fix the flag"), task("Fix the docs")], operationId: "op-timeout" };

    const result = JSON.parse(await stack.startCall(turn, input));
    expect(result).toMatchObject({ ok: false, error: { code: "unanswered" } });
    expect(result.error.message).toContain("Say so and stop");
    expect(stack.children()).toHaveLength(0);

    const replay = JSON.parse(await stack.startCall(turn, input));
    expect(replay).toMatchObject({ ok: false, error: { code: "unanswered" } });
    expect(ask).toHaveBeenCalledTimes(1);
    stack.fake.release(turn.runId);
  }, slow);

  it("returns unavailable when the question is withdrawn while the turn goes on, and creates nothing", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const pending = stack.startCall(turn, { tasks: [task("Fix the flag")], operationId: "op-cancelled" });
    await stack.nextQuestion(0);
    // What turn end and session close do to the channel's open questions.
    stack.agentSessions.turnTools.questions.release(stack.parentId);

    expect(JSON.parse(await pending)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(stack.children()).toHaveLength(0);
    // Not remembered: a retry asks again.
    const retry = stack.startCall(turn, { tasks: [task("Fix the flag")], operationId: "op-cancelled" });
    await stack.answer(await stack.nextQuestion(1), { "task-0": "here" });
    expect(JSON.parse(await retry).tasks[0].outcome).toBe("do_here");
    stack.fake.release(turn.runId);
  }, slow);

  it("creates nothing when the turn ends while the card is open, even if an answer would have come", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const pending = stack.startCall(turn, { tasks: [task("Fix the flag")], operationId: "op-ended" });
    const question = await stack.nextQuestion(0);
    expect((await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.parentId}/cancel` })).statusCode).toBe(200);

    expect(await pending).toBe(CHILD_TOOLS_UNAVAILABLE_RESULT);
    const late = await stack.app.inject({
      method: "POST",
      url: `/api/agent-sessions/${stack.parentId}/questions/${question.requestId}`,
      payload: { answers: [{ setId: "task-0", selectedOptionIds: ["worktree"] }] }
    });
    expect(late.statusCode).not.toBe(200);
    await sleep(100);
    expect(stack.children()).toHaveLength(0);
    expect(stack.changes).toHaveLength(0);
  }, slow);

  it("still asks the person about an offer made in a report-back wake", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const first = stack.startCall(turn, { tasks: [task("Fix the flag")], operationId: "op-first" });
    await stack.answer(await stack.nextQuestion(0), { "task-0": "worktree" });
    const childId = JSON.parse(await first).tasks[0].child.sessionId as string;
    await until(() => stack.agentSessions.getSession(childId)?.status === "idle");
    // The child's report wakes the parent once the person's turn ends.
    stack.fake.hold = (input) => input.sessionId === stack.parentId;
    stack.fake.release(turn.runId);
    await until(() => stack.fake.inputsOf(stack.parentId).length === 2);
    const wake = stack.fake.inputsOf(stack.parentId)[1]!;
    expect(wake.prompt).toContain("finished a turn");

    const fromWake = stack.startCall(wake, { tasks: [task("Fix the docs")], operationId: "op-wake" });
    const question = await stack.nextQuestion(1);
    expect(question.turnId).toBe(wake.runId);
    await stack.answer(question, { "task-0": "here" });
    expect(JSON.parse(await fromWake).tasks[0].outcome).toBe("do_here");
    stack.fake.hold = () => false;
    stack.fake.release(wake.runId);
  }, slow);

  it("answers offer_unavailable without a card when clarifying questions are off", async () => {
    const stack = await offerStack({ clarifyingQuestionsEnabled: false });
    const turn = await stack.holdParentTurn();
    const result = JSON.parse(await stack.startCall(turn, { tasks: [task("Fix the flag")], operationId: "op-off" }));
    expect(result).toMatchObject({ ok: false, error: { code: "offer_unavailable" } });
    expect(stack.questions).toHaveLength(0);
    expect(stack.children()).toHaveLength(0);
    stack.fake.release(turn.runId);
  }, slow);

  it("refuses an offer that names more tasks than free slots before any card", async () => {
    const stack = await offerStack();
    const turn = await stack.holdParentTurn();
    const three = stack.startCall(turn, { tasks: [task("One"), task("Two"), task("Three")], operationId: "op-three" });
    await stack.answer(await stack.nextQuestion(0), { "task-0": "worktree", "task-1": "worktree", "task-2": "worktree" });
    await three;
    expect(stack.children()).toHaveLength(3);

    const over = JSON.parse(await stack.startCall(turn, { tasks: [task("Four"), task("Five")], operationId: "op-over" }));
    expect(over).toMatchObject({ ok: false, error: { code: "child_limit_reached", freeSlots: 1 } });
    expect(stack.questions).toHaveLength(1);
    stack.fake.release(turn.runId);
  }, slow);
});
