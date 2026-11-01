import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_REPORT_WAKE_BUDGET, ChildReports } from "../src/children/ChildReports";
import type { ChildThreadSummary } from "../src/domain/childThreads";
import type { AgentSession, AgentSessionTurn, LocalWorkspace, ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerBackgroundListener, AgentRunnerEvent } from "../src/runner/AgentRunner";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import { buildServer } from "../src/server";
import { config, createGitWorkspace, git, waitForSessionWhere } from "./support/agentSessionHarness";
import { jobRegistered, jobSettled, rootTurn, say, toolCall, toolResult, writeScriptedDeepSeekRuntime } from "./support/scriptedDeepSeekRuntime";

// Report-back wakes against real temporary repositories. The fake runner
// settles every run at once unless `holdWhen` holds it, records each prompt,
// and can start a turn of its own the way a runner's background work does.

const slow = 30_000;
const settleTimeout = 20_000;

interface ReportRunnerControls {
  /** Holds a run for this session until `release`; read when the run starts. */
  holdWhen(sessionId: string): boolean;
  reply(sessionId: string): string;
}

function reportRunner() {
  const prompts: Array<{ sessionId: string; runId: string; prompt: string }> = [];
  const gates = new Map<string, { sessionId: string; open(): void }>();
  const cancelled = new Set<string>();
  let listener: AgentRunnerBackgroundListener | undefined;
  let agentTurn: AsyncEventQueue<AgentRunnerEvent> | undefined;
  const controls: ReportRunnerControls = { holdWhen: () => false, reply: () => "Done" };
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      const sessionId = input.sessionId ?? "";
      prompts.push({ sessionId, runId: input.runId, prompt: input.prompt });
      if (controls.holdWhen(sessionId)) {
        await new Promise<void>((resolve) => gates.set(input.runId, { sessionId, open: resolve }));
      }
      if (cancelled.has(input.runId)) {
        yield { type: "run_failed", error: "interrupted" };
        return;
      }
      yield { type: "run_succeeded", message: controls.reply(sessionId) };
    },
    async cancel(runId) {
      cancelled.add(runId);
      gates.get(runId)?.open();
    },
    watchBackgroundWork(next) {
      listener = next;
    }
  };
  return Object.assign(controls, {
    runner,
    prompts,
    release(sessionId: string) {
      for (const [runId, gate] of gates) {
        if (gate.sessionId !== sessionId) continue;
        gates.delete(runId);
        gate.open();
      }
    },
    promptsOf: (sessionId: string) => prompts.filter((prompt) => prompt.sessionId === sessionId).map((prompt) => prompt.prompt),
    /** Starts a turn of the runner's own on the session; true when the service accepted it. */
    startAgentTurn(sessionId: string, afterRunId?: string): boolean {
      let accepted = false;
      listener!.turnStarted({
        sessionId,
        ...(afterRunId ? { afterRunId } : {}),
        finished: [{ id: "task-1", status: "completed", description: "Run the tests" }],
        start: () => {
          accepted = true;
          agentTurn = new AsyncEventQueue<AgentRunnerEvent>();
          return agentTurn;
        }
      });
      return accepted;
    },
    finishAgentTurn() {
      agentTurn!.push({ type: "run_succeeded", message: "The tests pass." });
      agentTurn!.close();
    }
  });
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

interface StartedTurn {
  sessionId: string;
  turnId: string;
  trigger?: { kind: string; reports?: Array<{ childSessionId: string; turnId: string; status: string }> };
}

async function parentStack(runners: Partial<Record<string, AgentRunner>> = {}, parentRunner = "codex") {
  const fake = reportRunner();
  const serviceConfig: ServiceConfig = await config();
  const built = await buildServer({ config: serviceConfig, runners: { codex: fake.runner, ...runners } });
  closers.push(() => built.app.close());
  const started: StartedTurn[] = [];
  built.eventBus.subscribe((event) => {
    if (event.type === "agent_turn_started") started.push(event.payload as StartedTurn);
  });
  const { app } = built;
  const workspacePath = await createGitWorkspace();
  const workspace = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspacePath } })).json().workspace as LocalWorkspace;
  const parentId = (await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, title: "Parent", runnerKind: parentRunner } }))
    .json().session.id as string;

  const createChild = async (title: string) => {
    const created = await app.inject({ method: "POST", url: `/api/agent-sessions/${parentId}/children`, payload: { title, task: "Do it.", runnerKind: "codex" } });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { session: { id: string; activeTurnId: string }; workspace: LocalWorkspace };
    return { id: body.session.id, turnId: body.session.activeTurnId, worktree: body.workspace.worktree! };
  };
  const turn = async (sessionId: string, message: string) => {
    const response = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message } });
    expect(response.statusCode).toBe(202);
    return response.json().turn.id as string;
  };
  // Wakes run behind scripted runner steps and Git reads, so a settle waits on
  // wall time well inside the 30 s test timeout rather than a poll count.
  const settled = (sessionId: string, turnCount: number) =>
    waitForSessionWhere(app, sessionId, (session) => session.status === "idle" && session.turnCount === turnCount, `${sessionId} to settle ${turnCount} turns`, settleTimeout);
  const list = async () => (await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json() as { waitingReports: number };
  const waitingReports = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await list()).waitingReports === count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${count} waiting reports`);
  };
  const parentTriggers = () => started.filter((entry) => entry.sessionId === parentId).map((entry) => entry.trigger?.kind);
  const wakes = () => started.filter((entry) => entry.sessionId === parentId && entry.trigger?.kind === "child_report");
  const messages = async (sessionId: string) =>
    (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).json().messages as Array<{ turnId: string; role: string; content: string }>;
  return { ...built, fake, serviceConfig, workspacePath, parentId, createChild, turn, settled, list, waitingReports, parentTriggers, wakes, messages };
}

describe("child report wakes", () => {
  it("wakes the parent with one block per child when a child's turn settles", async () => {
    const stack = await parentStack();
    stack.fake.holdWhen = (sessionId) => sessionId !== stack.parentId;
    stack.fake.reply = (sessionId) => (sessionId === stack.parentId ? "Noted." : `Added the flag. ${"x".repeat(2_500)}`);
    const child = await stack.createChild("Add a --json flag");
    await writeFile(join(child.worktree.worktreePath, "feature.txt"), "feature\n");
    await git(child.worktree.worktreePath, "add", "feature.txt");
    await git(child.worktree.worktreePath, "commit", "-m", "Add feature");
    await writeFile(join(child.worktree.worktreePath, "draft.txt"), "draft\n");

    stack.fake.holdWhen = () => false;
    stack.fake.release(child.id);
    await stack.settled(stack.parentId, 1);

    expect(stack.wakes()).toEqual([expect.objectContaining({
      trigger: { kind: "child_report", reports: [{ childSessionId: child.id, turnId: child.turnId, status: "succeeded" }], tasks: [] }
    })]);
    const opening = (await stack.messages(stack.parentId)).find((message) => message.role === "system")!;
    expect(opening.origin).toBe("child_report");
    const lines = opening.content.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "A child thread finished a turn. Landing, updating and closing children are the person's actions.",
      "",
      `Child "Add a --json flag" (${child.id}): succeeded`,
      `Branch: ${child.worktree.branch}, 1 commit the parent checkout does not have`,
      "Changes from the base: 1 file, +1 -0; uncommitted changes in the worktree"
    ]);
    expect(lines[5]).toBe("Last message:");
    expect(lines[6]).toHaveLength(2_000);
    expect(lines[6]!.startsWith("Added the flag.")).toBe(true);
    // The wake's message is its runner input; the context assembler adds no held-back reports to it.
    const [prompt] = stack.fake.promptsOf(stack.parentId);
    expect(prompt).toContain(opening.content);
    expect(prompt).not.toContain("held back report turns");
    expect((await stack.list()).waitingReports).toBe(0);
  }, slow);

  it(`runs ${CHILD_REPORT_WAKE_BUDGET} wakes in a row, then holds reports for the person's next turn, which resets the count`, async () => {
    const stack = await parentStack();
    const child = await stack.createChild("Fix the parser");
    await stack.settled(stack.parentId, 1);
    await stack.turn(child.id, "again");
    await stack.settled(stack.parentId, 2);
    await stack.turn(child.id, "and again");
    await stack.settled(stack.parentId, 3);
    expect(stack.wakes()).toHaveLength(3);

    // A turn the runner starts itself neither counts nor resets the budget.
    expect(stack.fake.startAgentTurn(stack.parentId)).toBe(true);
    stack.fake.finishAgentTurn();
    await stack.settled(stack.parentId, 4);

    await stack.turn(child.id, "one more");
    await stack.waitingReports(1);
    expect(stack.wakes()).toHaveLength(3);

    await stack.turn(stack.parentId, "What did the child do?");
    await stack.settled(stack.parentId, 5);
    const personPrompt = stack.fake.promptsOf(stack.parentId).at(-1)!;
    expect(personPrompt).toContain("Child thread reports that arrived while AgentRoom held back report turns.");
    expect(personPrompt).toContain(`Child "Fix the parser" (${child.id}): succeeded`);
    expect(personPrompt.endsWith("What did the child do?")).toBe(true);
    // Volatile: the transcript keeps the person's own words only.
    const personMessage = (await stack.messages(stack.parentId)).filter((message) => message.role === "user").at(-1)!;
    expect(personMessage.content).toBe("What did the child do?");
    expect((await stack.list()).waitingReports).toBe(0);

    await stack.turn(child.id, "last one");
    await stack.settled(stack.parentId, 6);
    expect(stack.wakes()).toHaveLength(4);
    expect(stack.parentTriggers()).toEqual(["child_report", "child_report", "child_report", "background_task", undefined, "child_report"]);
    expect(stack.fake.promptsOf(stack.parentId).at(-1)).not.toContain("held back report turns");
  }, slow);

  it("waits while the parent is busy, then reports every waiting child in one wake", async () => {
    const stack = await parentStack();
    stack.fake.holdWhen = () => true;
    const first = await stack.createChild("First fix");
    const second = await stack.createChild("Second fix");
    await stack.turn(stack.parentId, "Keep going");

    stack.fake.release(first.id);
    stack.fake.release(second.id);
    await stack.waitingReports(2);
    expect(stack.wakes()).toHaveLength(0);

    stack.fake.holdWhen = () => false;
    stack.fake.release(stack.parentId);
    await stack.settled(stack.parentId, 2);
    const [wake] = stack.wakes();
    expect(stack.wakes()).toHaveLength(1);
    expect(wake!.trigger!.reports!.map((report) => report.childSessionId).sort()).toEqual([first.id, second.id].sort());
    const opening = (await stack.messages(stack.parentId)).find((message) => message.turnId === wake!.turnId)!;
    expect(opening.content).toMatch(/^2 child threads finished a turn\./);
    expect(opening.content).toContain(`Child "First fix" (${first.id}): succeeded`);
    expect(opening.content).toContain(`Child "Second fix" (${second.id}): succeeded`);
  }, slow);

  it("lets a runner's own waiting turn go first", async () => {
    const stack = await parentStack();
    stack.fake.holdWhen = () => true;
    const child = await stack.createChild("Fix the flag");
    const personTurn = await stack.turn(stack.parentId, "Keep going");
    stack.fake.release(child.id);
    await stack.waitingReports(1);

    // The runner names its next turn while the person's is still settling.
    expect(stack.fake.startAgentTurn(stack.parentId, personTurn)).toBe(true);
    stack.fake.holdWhen = () => false;
    stack.fake.release(stack.parentId);
    await waitForSessionWhere(stack.app, stack.parentId, (session) => session.turnCount === 1 && session.status === "running", "the runner's turn to open");
    expect(stack.parentTriggers()).toEqual([undefined, "background_task"]);
    expect((await stack.list()).waitingReports).toBe(1);

    stack.fake.finishAgentTurn();
    await stack.settled(stack.parentId, 3);
    expect(stack.parentTriggers()).toEqual([undefined, "background_task", "child_report"]);
  }, slow);

  it("opens no wake for a parent that cannot continue, and keeps the report waiting", async () => {
    const stack = await parentStack();
    const canContinue = stack.agentSessions.canContinue.bind(stack.agentSessions);
    vi.spyOn(stack.agentSessions, "canContinue").mockImplementation((sessionId) => sessionId !== stack.parentId && canContinue(sessionId));
    const child = await stack.createChild("Fix the flag");
    await waitForSessionWhere(stack.app, child.id, (session) => session.turnCount === 1, "the child's turn to settle");
    await stack.waitingReports(1);
    expect(stack.wakes()).toHaveLength(0);
    expect(stack.fake.promptsOf(stack.parentId)).toEqual([]);
  }, slow);

  it("reports a child whose turn was stopped as cancelled", async () => {
    const stack = await parentStack();
    stack.fake.holdWhen = (sessionId) => sessionId !== stack.parentId;
    const child = await stack.createChild("Fix the flag");
    const stopped = await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${child.id}/cancel` });
    expect(stopped.statusCode).toBe(200);
    await stack.settled(stack.parentId, 1);

    const [wake] = stack.wakes();
    expect(wake!.trigger!.reports).toEqual([{ childSessionId: child.id, turnId: child.turnId, status: "cancelled" }]);
    const opening = (await stack.messages(stack.parentId)).find((message) => message.turnId === wake!.turnId)!;
    expect(opening.content).toContain(`Child "Fix the flag" (${child.id}): cancelled`);
  }, slow);
});

describe("child report wakes on a DeepSeek parent", () => {
  async function deepseekRunner(prompts: Parameters<typeof writeScriptedDeepSeekRuntime>[0], options: { promptLog?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), "agentroom-child-report-deepseek-"));
    const runtime = await writeScriptedDeepSeekRuntime(prompts, options);
    return new DeepSeekHarnessRunner({
      ...(await config()),
      workspaceRoot: root,
      stateDir: join(root, ".state"),
      deepseekExecutable: process.execPath,
      deepseekCordisConfig: join(root, "cordis.yml"),
      deepseekArgs: [runtime],
      deepseekModel: "deepseek-flash",
      clarifyingQuestionsEnabled: false
    } as ServiceConfig);
  }

  it("opens no wake for a parent whose turn was stopped, because the stop ended its runtime", async () => {
    // The parent's turn never ends on its own, so the person stops it.
    const deepseek = await deepseekRunner([[{ status: "running" }, { event: "turn/start", data: { turn: 1 } }, { wait: 60_000 }]]);
    const stack = await parentStack({ deepseek }, "deepseek");
    stack.fake.holdWhen = () => true;
    const child = await stack.createChild("Fix the flag");
    const parentTurn = await stack.turn(stack.parentId, "Start the job");
    await waitForSessionWhere(stack.app, stack.parentId, (session) => session.status === "running", "the parent's turn to run");
    expect((await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.parentId}/cancel` })).statusCode).toBe(200);
    await waitForSessionWhere(stack.app, stack.parentId, (session) => session.status === "idle", "the parent's stopped turn to settle");
    // The session service still counts the session continuable; only the stop says otherwise.
    expect(stack.agentSessions.canContinue(stack.parentId)).toBe(true);

    stack.fake.release(child.id);
    await stack.waitingReports(1);
    expect(stack.wakes()).toHaveLength(0);
    expect(stack.parentTriggers()).toEqual([undefined]);
    expect((await stack.messages(stack.parentId)).map((message) => message.turnId)).toEqual(expect.arrayContaining([parentTurn]));
  }, slow);

  it("delivers the report text to the agent when the wake races the runtime's own turn", async () => {
    const promptLog = join(await mkdtemp(join(tmpdir(), "agentroom-child-report-prompts-")), "prompts.jsonl");
    const notice = { kind: "tool-jobs", form: "notice", summary: "bash sleep 1 [status: completed]" };
    // The parent's first turn leaves a background job that settles at once.
    // The runtime starts its own turn for it a moment later, so a wake that
    // opens in between is the race the DeepSeek guide records.
    const deepseek = await deepseekRunner([
      [
        ...rootTurn(1, [
          toolCall("call-1", "bash", { command: "sleep 1", description: "Wait", run_in_background: true }),
          jobRegistered("bash-1", "sleep 1", "call-1"),
          toolResult("call-1", "started background job bash-1"),
          say("started")
        ]),
        { wait: 20 },
        jobSettled("bash-1", "sleep 1", "call-1", "completed"),
        { wait: 300 },
        ...rootTurn(2, [say("The job finished.")], notice)
      ],
      [{ wait: 400 }, ...rootTurn(3, [say("The child fixed the flag.")])]
    ], { promptLog });
    const stack = await parentStack({ deepseek }, "deepseek");
    stack.fake.holdWhen = () => true;
    stack.fake.reply = () => "Fixed the flag in cli.ts.";
    const child = await stack.createChild("Fix the flag");

    await stack.turn(stack.parentId, "Start the job");
    await stack.settled(stack.parentId, 1);
    stack.fake.release(child.id);

    // On this script the wake opens first, takes the runtime's job reply, and
    // the reply to the report opens as a background turn. Under load the
    // runtime's turn can start, and end, before the wake's stream attaches;
    // the runner folds it into the wake then too. The labels are accepted
    // either way round: the wake is recorded and both replies arrive.
    await waitForSessionWhere(stack.app, stack.parentId, (session) => session.status === "idle" && session.turnCount === 3, "both runtime turns to settle", settleTimeout);
    expect(stack.wakes()).toHaveLength(1);
    const replies = (await stack.messages(stack.parentId)).filter((message) => message.role === "assistant").map((message) => message.content);
    expect(replies).toEqual(expect.arrayContaining(["The job finished.", "The child fixed the flag."]));

    const prompts = (await readFile(promptLog, "utf8")).trim().split("\n").map((line) => JSON.stringify(JSON.parse(line)));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`Child \\"Fix the flag\\" (${child.id}): succeeded`);
    expect(prompts[1]).toContain("Fixed the flag in cli.ts.");
  }, slow);
});

describe("child report delivery", () => {
  it("does not report again what a person's turn carried while a wake lost the parent to that turn", async () => {
    const parent = { id: "parent", runnerKind: "codex", status: "idle" } as AgentSession;
    const child = (id: string) => ({ id, runnerKind: "codex", status: "idle", parent: { sessionId: parent.id, workspaceId: "w" } }) as AgentSession;
    const sessions = new Map([parent, child("a"), child("b")].map((session) => [session.id, session]));
    const latest = new Map<string, AgentSessionTurn>();
    const settled = (sessionId: string) => {
      const turn = { id: `turn-${sessionId}`, sessionId, status: "succeeded", lastMessage: `done ${sessionId}` } as AgentSessionTurn;
      latest.set(sessionId, turn);
      return turn;
    };
    const starts: Array<{ message: string; reject(error: Error): void }> = [];
    const reports = new ChildReports({
      sessions: {
        getSession: (id) => sessions.get(id),
        latestTurn: (id) => latest.get(id),
        hasWaitingAgentTurn: () => false,
        startTurn: (input) => new Promise((_resolve, reject) => starts.push({ message: input.origin?.message ?? "", reject }))
      },
      continuable: () => true,
      eventBus: { subscribe: () => () => {} },
      summary: async (session) => ({
        sessionId: session.id, title: session.id, branch: `agentroom/${session.id}`, commitsAhead: 1, missing: false, uncommitted: false,
        diff: { files: 1, insertions: 1, deletions: 0 }
      }) as ChildThreadSummary
    });

    // A's wake fails for a reason that leaves the parent idle, so A waits.
    reports.turnEvent(sessions.get("a")!, settled("a"));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    starts[0]!.reject(new Error("plan state could not be saved"));
    await vi.waitFor(() => expect(reports.waitingCount(parent.id)).toBe(1));

    // A person's turn takes A as context; B settles and its wake takes A too.
    const context = await reports.prepareSummaryForTurn(parent);
    reports.turnEvent(sessions.get("b")!, settled("b"));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.message).toContain("done a");
    // The person's turn is accepted first, and the wake then loses the parent to it.
    context?.acknowledge();
    starts[1]!.reject(new Error("Agent session already has a running turn"));

    await vi.waitFor(() => expect(reports.waitingCount(parent.id)).toBe(1));
    reports.turnEvent(parent, { id: "person-turn", sessionId: parent.id, status: "succeeded" } as AgentSessionTurn);
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2]!.message).toContain("done b");
    expect(starts[2]!.message).not.toContain("done a");
  });
});
