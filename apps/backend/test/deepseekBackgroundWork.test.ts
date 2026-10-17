import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackgroundTask, AgentFinishedBackgroundTask } from "../src/domain/backgroundWork";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { DeepSeekBackgroundWork } from "../src/runner/deepseek/backgroundWork";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { resolveAgentRoomCordisPlugin } from "../src/runner/deepseek/cordis/runtime";
import {
  jobRegistered,
  jobSettled,
  rootTurn,
  say,
  toolCall,
  toolResult,
  writeScriptedDeepSeekRuntime,
  type ScriptedStep
} from "./support/scriptedDeepSeekRuntime";

const runners: DeepSeekHarnessRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map((runner) => runner.dispose())); });

async function runnerFor(prompts: ScriptedStep[][]): Promise<{ runner: DeepSeekHarnessRunner; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-deepseek-background-"));
  const runtime = await writeScriptedDeepSeekRuntime(prompts);
  const runner = new DeepSeekHarnessRunner({
    runnerKind: "deepseek",
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    deepseekExecutable: process.execPath,
    deepseekCordisConfig: join(root, "cordis.yml"),
    deepseekArgs: [runtime],
    deepseekModel: "deepseek-flash",
    clarifyingQuestionsEnabled: false,
    codexArgs: []
  } as unknown as ServiceConfig);
  runners.push(runner);
  return { runner, workspace: root };
}

interface StartedTurn {
  afterRunId?: string;
  finished: AgentFinishedBackgroundTask[];
  events: AgentRunnerEvent[];
  done: Promise<void>;
}

/** A service stand-in that records lists and, unless told to refuse, accepts every agent turn. */
function watch(runner: DeepSeekHarnessRunner, options: { refuse?: boolean } = {}) {
  const lists: AgentBackgroundTask[][] = [];
  const turns: StartedTurn[] = [];
  runner.watchBackgroundWork({
    tasksChanged: ({ sessionId, tasks }) => {
      expect(sessionId).toBe("session-1");
      lists.push(tasks);
    },
    turnStarted: (input) => {
      const turn: StartedTurn = { afterRunId: input.afterRunId, finished: input.finished, events: [], done: Promise.resolve() };
      turns.push(turn);
      if (options.refuse) return;
      const events = input.start(`agent-turn-${turns.length}`);
      turn.done = (async () => { for await (const event of events) turn.events.push(event); })();
    }
  });
  return { lists, turns };
}

async function run(runner: DeepSeekHarnessRunner, workspace: string, runId: string, prompt = "go"): Promise<AgentRunnerEvent[]> {
  const events: AgentRunnerEvent[] = [];
  for await (const event of runner.run({ runId, sessionId: "session-1", workspacePath: workspace, prompt })) events.push(event);
  return events;
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const backgroundBash = (callId: string, command: string) =>
  toolCall(callId, "bash", { command, description: "Run in the background", run_in_background: true });

describe("DeepSeek background work", () => {
  it("lists a background shell job while it runs and drops it when it settles", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        backgroundBash("call-1", "sleep 12 && echo done"),
        jobRegistered("bash-1", "sleep 12 && echo done", "call-1"),
        toolResult("call-1", "started background job bash-1"),
        say("started")
      ]),
      { wait: 50 },
      jobSettled("bash-1", "sleep 12 && echo done", "call-1", "completed")
    ]]);
    const { lists } = watch(runner, { refuse: true });

    expect((await run(runner, workspace, "turn-1")).at(-1)).toEqual({ type: "run_succeeded" });
    await until(() => lists.length >= 2);

    expect(lists[0]).toEqual([{
      id: "bash-1",
      kind: "shell",
      description: "sleep 12 && echo done",
      startedAt: new Date(1_760_000_000_000).toISOString()
    }]);
    expect(lists[1]).toEqual([]);
  });

  it("never lists a foreground call's job, and lists one still running when its call returns", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        toolCall("call-1", "bash", { command: "echo quick" }),
        jobRegistered("bash-quick", "echo quick", "call-1"),
        jobSettled("bash-quick", "echo quick", "call-1", "completed"),
        toolResult("call-1", "quick"),
        toolCall("call-2", "bash", { command: "make slow" }),
        jobRegistered("bash-slow", "make slow", "call-2"),
        toolResult("call-2", "promoted to background job bash-slow"),
        say("still building")
      ]),
      { wait: 50 },
      jobSettled("bash-slow", "make slow", "call-2", "failed")
    ]]);
    const { lists } = watch(runner, { refuse: true });

    await run(runner, workspace, "turn-1");
    await until(() => lists.length >= 2);

    expect(lists.map((tasks) => tasks.map((task) => task.id))).toEqual([["bash-slow"], []]);
  });

  it("opens the turn the runtime starts after a job settles, naming the job, and streams it to its end", async () => {
    const notice = { kind: "tool-jobs", form: "notice", summary: "bash sleep 1 [status: completed, exit code: 0]" };
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        backgroundBash("call-1", "sleep 1"),
        jobRegistered("bash-1", "sleep 1", "call-1"),
        toolResult("call-1", "started background job bash-1"),
        say("started")
      ]),
      { wait: 50 },
      jobSettled("bash-1", "sleep 1", "call-1", "completed"),
      ...rootTurn(2, [say("The job finished.")], notice)
    ]]);
    const { turns } = watch(runner);

    await run(runner, workspace, "turn-1");
    await until(() => turns.length === 1);
    await turns[0]!.done;

    expect(turns[0]).toMatchObject({
      afterRunId: "turn-1",
      finished: [{ id: "bash-1", description: "sleep 1", status: "completed" }]
    });
    expect(turns[0]!.events.flatMap((event) => event.type === "agent_update" ? [event.message] : [])).toEqual(["The job finished."]);
    expect(turns[0]!.events.at(-1)).toEqual({ type: "run_succeeded" });
  });

  it("lists a subagent under its tool call's description and names it, with its last words, in the turn it starts", async () => {
    const child = "child-1";
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        toolCall("call-1", "subagent", { description: "Review the diff", prompt: "Review the staged diff." }),
        { notify: "subagent.started", params: { parentSessionId: "$root", childSessionId: child } },
        toolResult("call-1", `started subagent ${child}`),
        say("delegated")
      ]),
      { event: "turn/start", session: child, data: { turn: 1 } },
      toolCall("child-call-1", "bash", { command: "git diff --staged" }, child),
      jobRegistered("bash-child", "git diff --staged", "child-call-1", child),
      jobSettled("bash-child", "git diff --staged", "child-call-1", "completed", child),
      toolResult("child-call-1", "diff", child),
      say("The diff looks fine.", child),
      { event: "turn/end", session: child, data: { turn: 1, reason: { kind: "completed" } } },
      ...rootTurn(2, [
        { notify: "subagent.finished", params: {
          provider: "spawn", agentId: child, parentSessionId: "$root", childSessionId: child, status: "ok", stopReason: "completed"
        } },
        say("The review is done.")
      ], { kind: "subagent-settled", form: "notice", summary: "finished", senderSessionId: child })
    ]]);
    const { lists, turns } = watch(runner);

    await run(runner, workspace, "turn-1");
    await until(() => turns.length === 1);
    await turns[0]!.done;

    expect(lists.map((tasks) => tasks.map(({ id, kind, description }) => ({ id, kind, description })))).toEqual([
      [{ id: child, kind: "agent", description: "Review the diff" }],
      []
    ]);
    expect(turns[0]!.finished).toEqual([
      { id: child, description: "Review the diff", status: "completed", summary: "The diff looks fine." }
    ]);
    expect(turns[0]!.events.flatMap((event) => event.type === "agent_update" ? [event.message] : [])).toEqual(["The review is done."]);
  });

  it("names in each agent turn only the work that ended since the agent last saw an ending", async () => {
    const notice = { kind: "tool-jobs", form: "notice", summary: "bash [status: completed]" };
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        backgroundBash("call-1", "sleep 1"), jobRegistered("bash-1", "sleep 1", "call-1"), toolResult("call-1", "started"),
        backgroundBash("call-2", "sleep 2"), jobRegistered("bash-2", "sleep 2", "call-2"), toolResult("call-2", "started"),
        backgroundBash("call-3", "sleep 3"), jobRegistered("bash-3", "sleep 3", "call-3"), toolResult("call-3", "started"),
        say("started")
      ]),
      { wait: 20 },
      jobSettled("bash-1", "sleep 1", "call-1", "completed"),
      // The runtime folds the second ending into the turn it already runs.
      ...rootTurn(2, [jobSettled("bash-2", "sleep 2", "call-2", "completed"), say("one and two are done")], notice),
      { wait: 20 },
      jobSettled("bash-3", "sleep 3", "call-3", "completed"),
      ...rootTurn(3, [say("three is done")], notice)
    ]]);
    const { turns } = watch(runner);

    await run(runner, workspace, "turn-1");
    await until(() => turns.length === 2);
    await turns[1]!.done;

    expect(turns.map((turn) => turn.finished.map((task) => task.id))).toEqual([["bash-1"], ["bash-3"]]);
  });

  it("leaves out of agent turns a job the model killed itself and a subagent's own jobs, which the runtime never reports to the agent", async () => {
    const child = "child-1";
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        backgroundBash("call-1", "sleep 1"), jobRegistered("bash-1", "sleep 1", "call-1"), toolResult("call-1", "started"),
        backgroundBash("call-2", "sleep 2"), jobRegistered("bash-2", "sleep 2", "call-2"), toolResult("call-2", "started"),
        toolCall("call-3", "job_kill", { job_id: "bash-2" }), toolResult("call-3", "cancellation requested"),
        toolCall("call-4", "subagent", { description: "Helper", prompt: "go" }),
        { notify: "subagent.started", params: { parentSessionId: "$root", childSessionId: child } },
        toolResult("call-4", `started subagent ${child}`),
        say("working")
      ]),
      { event: "turn/start", session: child, data: { turn: 1 } },
      toolCall("child-call-1", "bash", { command: "sleep 5", run_in_background: true }, child),
      jobRegistered("bash-child", "sleep 5", "child-call-1", child),
      toolResult("child-call-1", "started", child),
      say("Helper is done.", child),
      { event: "turn/end", session: child, data: { turn: 1, reason: { kind: "completed" } } },
      { wait: 20 },
      jobSettled("bash-2", "sleep 2", "call-2", "killed"),
      jobSettled("bash-child", "sleep 5", "child-call-1", "completed", child),
      ...rootTurn(2, [say("The helper reported.")], { kind: "subagent-settled", form: "notice", summary: "finished", senderSessionId: child }),
      { wait: 20 },
      jobSettled("bash-1", "sleep 1", "call-1", "completed"),
      ...rootTurn(3, [say("Job one is done.")], { kind: "tool-jobs", form: "notice", summary: "bash [status: completed]" })
    ]]);
    const { turns } = watch(runner);

    await run(runner, workspace, "turn-1");
    await until(() => turns.length === 2);
    await turns[1]!.done;

    expect(turns.map((turn) => turn.finished.map((task) => task.id))).toEqual([[child], ["bash-1"]]);
  });

  it("lists a subagent's job under it only while the subagent is listed", async () => {
    const child = "child-1";
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        toolCall("call-1", "subagent", { description: "Helper", prompt: "go" }),
        { notify: "subagent.started", params: { parentSessionId: "$root", childSessionId: child } },
        toolResult("call-1", `started subagent ${child}`),
        say("delegated")
      ]),
      { event: "turn/start", session: child, data: { turn: 1 } },
      toolCall("child-call-1", "bash", { command: "sleep 5", run_in_background: true }, child),
      jobRegistered("bash-child", "sleep 5", "child-call-1", child),
      toolResult("child-call-1", "started", child),
      { event: "turn/end", session: child, data: { turn: 1, reason: { kind: "completed" } } },
      { wait: 20 },
      jobSettled("bash-child", "sleep 5", "child-call-1", "completed", child)
    ]]);
    const { lists } = watch(runner, { refuse: true });

    await run(runner, workspace, "turn-1");
    await until(() => lists.length >= 4);

    expect(lists.map((tasks) => tasks.map(({ id, parentId }) => ({ id, parentId })))).toEqual([
      [{ id: child, parentId: undefined }],
      [{ id: child, parentId: undefined }, { id: "bash-child", parentId: child }],
      [{ id: "bash-child", parentId: undefined }],
      []
    ]);
  });

  it("pauses new subagents once the agent has started three turns in a row, until a person's turn", () => {
    const paused: boolean[] = [];
    const work = new DeepSeekBackgroundWork({ sessionId: "session-1", listener: () => undefined, pauseSubagents: (value) => paused.push(value) });

    work.agentTurnStarted();
    work.agentTurnStarted();
    expect(paused).toEqual([]);
    work.agentTurnStarted();
    work.agentTurnStarted();
    expect(paused).toEqual([true]);
    work.personTurnStarted();
    work.agentTurnStarted();
    work.personTurnStarted();
    expect(paused).toEqual([true, false]);
  });

  it("holds a refused turn's events until the runtime goes idle or starts its next turn", () => {
    const work = new DeepSeekBackgroundWork({ sessionId: "session-1", listener: () => undefined, pauseSubagents: () => undefined });
    const statusHeld = (sessionId: string, status: "running" | "idle") =>
      work.holdsRefusedTurn({ method: "session.status", params: { sessionId, status } }, undefined);
    const eventHeld = (type: string) => {
      const params = { sessionId: "session-1", event: { type, seq: 0, data: {} } };
      return work.holdsRefusedTurn({ method: "session.event", params }, params);
    };

    expect(eventHeld("assistant/message")).toBe(false);
    work.agentTurnRefused();
    expect(eventHeld("assistant/message")).toBe(true);
    expect(eventHeld("turn/end")).toBe(true);
    expect(statusHeld("child-1", "idle")).toBe(true);
    expect(statusHeld("session-1", "idle")).toBe(true);
    expect(eventHeld("assistant/message")).toBe(false);

    work.agentTurnRefused();
    expect(statusHeld("session-1", "running")).toBe(true);
    expect(eventHeld("turn/start")).toBe(false);
    expect(eventHeld("assistant/message")).toBe(false);
  });

  it("empties the list when the runtime exits, because its jobs die with it", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        backgroundBash("call-1", "sleep 60"),
        jobRegistered("bash-1", "sleep 60", "call-1"),
        toolResult("call-1", "started background job bash-1"),
        say("started")
      ]),
      { wait: 50 },
      { exit: 1 }
    ]]);
    const { lists } = watch(runner);

    await run(runner, workspace, "turn-1");
    await until(() => lists.length >= 2);

    expect(lists.map((tasks) => tasks.map((task) => task.id))).toEqual([["bash-1"], []]);
  });

  it("drops a refused agent turn and keeps the next person's turn to its own events", async () => {
    const notice = { kind: "tool-jobs", form: "notice", summary: "bash sleep 1 [status: completed]" };
    // The waits pin the order a slow host produced: the person's turn opens
    // after the refused turn's `turn/start` and before the rest of that turn
    // arrives, and the runtime answers the person only once its own turn ends.
    const { runner, workspace } = await runnerFor([
      [
        ...rootTurn(1, [backgroundBash("call-1", "sleep 1"), jobRegistered("bash-1", "sleep 1", "call-1"), toolResult("call-1", "started"), say("started")]),
        { wait: 20 },
        jobSettled("bash-1", "sleep 1", "call-1", "completed"),
        ...rootTurn(2, [{ wait: 150 }, say("unrouted agent reply")], notice)
      ],
      [{ wait: 400 }, ...rootTurn(3, [say("answer to the person")])]
    ]);
    const { turns } = watch(runner, { refuse: true });

    await run(runner, workspace, "turn-1");
    await until(() => turns.length === 1);
    const second = await run(runner, workspace, "turn-2", "next");

    expect(second.flatMap((event) => event.type === "agent_update" ? [event.message] : [])).toEqual(["answer to the person"]);
    expect(second.at(-1)).toEqual({ type: "run_succeeded" });
  });

  it("answers unknown_task for work it does not list, and unavailable when the graph has no AgentRoom plugin to stop it", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [backgroundBash("call-1", "sleep 60"), jobRegistered("bash-1", "sleep 60", "call-1"), toolResult("call-1", "started"), say("started")])
    ]]);
    const { lists } = watch(runner, { refuse: true });
    await run(runner, workspace, "turn-1");
    await until(() => lists.length === 1);

    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: "bash-other" })).toBe("unknown_task");
    expect(await runner.stopBackgroundTask({ sessionId: "session-2", taskId: "bash-1" })).toBe("unknown_task");
    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: "bash-1" })).toBe("unavailable");
  });

  it("does not hold a turn without tools for a plugin that never answers, and cannot stop work until it does", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [backgroundBash("call-1", "sleep 60"), jobRegistered("bash-1", "sleep 60", "call-1"), toolResult("call-1", "started"), say("started")])
    ]]);
    await writeFile(join(workspace, "cordis.yml"), `- insert:\n    - id: agentroom-tools\n      name: ${await resolveAgentRoomCordisPlugin()}\n`);
    const { lists } = watch(runner, { refuse: true });

    expect((await run(runner, workspace, "turn-1")).at(-1)).toEqual({ type: "run_succeeded" });
    await until(() => lists.length === 1);
    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: "bash-1" })).toBe("unavailable");
  }, 5_000);

  it("reads a call's arguments whether the runtime records them as JSON text or as an object", async () => {
    const { runner, workspace } = await runnerFor([[
      ...rootTurn(1, [
        { event: "tool/call", data: { callId: "call-1", name: "subagent", arguments: { description: "Object-argument helper", prompt: "go" } } },
        { notify: "subagent.started", params: { parentSessionId: "$root", childSessionId: "child-1" } },
        toolResult("call-1", "started subagent child-1"),
        { event: "tool/call", data: { callId: "call-2", name: "bash", arguments: { command: "sleep 9", run_in_background: true } } },
        jobRegistered("bash-1", "sleep 9", "call-2"),
        say("started")
      ])
    ]]);
    const { lists } = watch(runner, { refuse: true });

    await run(runner, workspace, "turn-1");
    await until(() => lists.length >= 2);

    expect(lists.at(-1)!.map(({ id, description }) => ({ id, description }))).toEqual([
      { id: "child-1", description: "Object-argument helper" },
      { id: "bash-1", description: "sleep 9" }
    ]);
  });
});
