import { describe, expect, it } from "vitest";
import type { AgentBackgroundTask, AgentFinishedBackgroundTask } from "../src/domain/backgroundWork";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { CodexBackgroundWork } from "../src/runner/codex/backgroundWork";
import type { JsonRpcNotification } from "../src/runner/shared/JsonRpcLineClient";

// Notification shapes and order recorded from codex-cli 0.160.0 on 2026-10-15
// (multi-agent v2): the parent's `subAgentActivity` item names the child
// thread before the child's first `turn/started`; the parent hears nothing
// when the child's turn is interrupted.
const PARENT = "parent-thread";
const CHILD = "child-thread";
const GRANDCHILD = "grandchild-thread";

describe("Codex subagents", () => {
  it("lists a spawned subagent until its thread's turn completes", () => {
    const { work, reports } = setUp();

    expect(work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/sleep_task"))).toBe(false);
    expect(work.observe(turnStarted(CHILD, "child-turn"))).toBe(true);
    expect(work.observe(command(CHILD, "child-turn"))).toBe(true);

    expect(reports.at(-1)).toEqual([{ id: CHILD, kind: "agent", description: "sleep task", startedAt: new Date(1_000).toISOString() }]);
    expect(work.hasLiveTasks).toBe(true);

    expect(work.observe(turnCompleted(CHILD, "child-turn", "completed"))).toBe(true);
    // The parent's own items go on to turn routing, which drops a finished turn's.
    expect(work.observe(finished(PARENT, "parent-turn", CHILD))).toBe(false);

    expect(reports.at(-1)).toEqual([]);
    expect(work.hasLiveTasks).toBe(false);
  });

  it("lists the subagent again when a follow-up starts another turn on its thread", () => {
    const { work, reports } = setUp();
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/reviewer"));
    work.observe(turnStarted(CHILD, "child-turn-1"));
    work.observe(turnCompleted(CHILD, "child-turn-1", "completed"));

    work.observe(turnStarted(CHILD, "child-turn-2"));
    // The parent's notice for the first turn arrives after the second began.
    work.observe(finished(PARENT, "parent-turn", CHILD));

    expect(reports.at(-1)?.map((task) => task.id)).toEqual([CHILD]);
  });

  it("names a nested subagent's parent while the parent is listed", () => {
    const { work, reports } = setUp();
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/lead"));
    work.observe(turnStarted(CHILD, "child-turn"));
    expect(work.observe(spawned(CHILD, "child-turn", GRANDCHILD, "/root/lead/helper"))).toBe(true);
    work.observe(turnStarted(GRANDCHILD, "grandchild-turn"));

    expect(reports.at(-1)?.find((task) => task.id === GRANDCHILD)?.parentId).toBe(CHILD);

    work.observe(turnCompleted(CHILD, "child-turn", "completed"));
    expect(reports.at(-1)?.map((task) => [task.id, task.parentId])).toEqual([[GRANDCHILD, undefined]]);
  });

  it("stops a subagent by interrupting its turn and ending the shells its thread left running", async () => {
    let shellAlive = true;
    const { work, reports, requests } = setUp({
      "thread/backgroundTerminals/list": () => ({ data: shellAlive ? [{ itemId: "exec-1", processId: "proc-9", command: "sleep 60" }] : [], nextCursor: null }),
      "turn/interrupt": {},
      "thread/backgroundTerminals/terminate": () => {
        shellAlive = false;
        return { terminated: true };
      }
    });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/sleep_task"));
    work.observe(turnStarted(CHILD, "child-turn"));

    await expect(work.stop(CHILD)).resolves.toBe("stopped");

    expect(requests).toEqual([
      ["turn/interrupt", { threadId: CHILD, turnId: "child-turn" }],
      ["thread/backgroundTerminals/list", { threadId: CHILD }],
      ["thread/backgroundTerminals/terminate", { threadId: CHILD, processId: "proc-9" }]
    ]);
    // Listed until the child's own turn says it ended.
    expect(reports.at(-1)).toHaveLength(1);
    work.observe(turnCompleted(CHILD, "child-turn", "interrupted"));
    expect(reports.at(-1)).toEqual([]);
    await expect(work.stop(CHILD)).resolves.toBe("unknown_task");
    await flush();
    expect(work.hasLiveTasks).toBe(false);
  });

  it("stops a subagent listed before its first turn started once that turn's id arrives", async () => {
    const { work, requests } = setUp({ "turn/interrupt": {}, "thread/backgroundTerminals/list": { data: [], nextCursor: null } });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/sleep_task"));

    await expect(work.stop(CHILD)).resolves.toBe("stopped");
    expect(requests).toEqual([]);

    work.observe(turnStarted(CHILD, "child-turn"));
    await flush();
    expect(requests[0]).toEqual(["turn/interrupt", { threadId: CHILD, turnId: "child-turn" }]);
  });

  it("lists the shells a finished subagent left running, keeps the child alive for them, and stops one", async () => {
    let shellAlive = true;
    const { work, reports, requests } = setUp({
      "thread/backgroundTerminals/list": () => ({ data: shellAlive ? [{ itemId: "exec-1", processId: "proc-9", command: "npm run dev" }] : [], nextCursor: null }),
      "thread/backgroundTerminals/terminate": () => {
        shellAlive = false;
        return { terminated: true };
      }
    });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/server"));
    work.observe(turnStarted(CHILD, "child-turn"));
    work.observe(command(CHILD, "child-turn"));

    work.observe(turnCompleted(CHILD, "child-turn", "completed"));
    await flush();

    expect(reports.at(-1)).toEqual([{ id: "exec-1", kind: "shell", description: "npm run dev", startedAt: new Date(1_500).toISOString() }]);
    expect(work.hasLiveTasks).toBe(true);

    await expect(work.stop("exec-1")).resolves.toBe("stopped");
    expect(requests.at(-1)).toEqual(["thread/backgroundTerminals/terminate", { threadId: CHILD, processId: "proc-9" }]);
    expect(work.observe({ method: "item/completed", params: { threadId: CHILD, turnId: "child-turn", item: { type: "commandExecution", id: "exec-1", status: "completed" } } })).toBe(true);
    expect(reports.at(-1)).toEqual([]);
    expect(work.hasLiveTasks).toBe(false);
  });

  it("names a running subagent as the parent of a shell its earlier turn left", async () => {
    const { work, reports } = setUp({
      "thread/backgroundTerminals/list": { data: [{ itemId: "exec-1", processId: "proc-9", command: "npm run dev" }], nextCursor: null }
    });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/server"));
    work.observe(turnStarted(CHILD, "child-turn-1"));
    work.observe(turnCompleted(CHILD, "child-turn-1", "completed"));
    await flush();

    work.observe(turnStarted(CHILD, "child-turn-2"));

    expect(reports.at(-1)?.map((task) => [task.id, task.parentId])).toEqual([[CHILD, undefined], ["exec-1", CHILD]]);
  });

  it("ends a subagent whose turn it never saw start when the spawner hears it finished", () => {
    const { work, reports } = setUp();
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/sleep_task"));

    work.observe(finished(PARENT, "parent-turn", CHILD));

    expect(reports.at(-1)).toEqual([]);
    expect(work.hasLiveTasks).toBe(false);
  });

  it("leaves a thread it never saw spawned to the session's routing", () => {
    const { work, reports } = setUp();

    expect(work.observe(turnStarted("stranger-thread", "t"))).toBe(false);
    expect(work.observe(turnCompleted("stranger-thread", "t", "completed"))).toBe(false);

    expect(reports).toEqual([]);
  });

  it("posts a subagent's last reply as a turn when it finishes while the thread is idle", async () => {
    const { work, turns } = setUp();
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/readme_reader"));
    work.observe(turnStarted(CHILD, "child-turn"));
    work.observe(reply(CHILD, "child-turn", "Looking now."));
    work.observe(reply(CHILD, "child-turn", "It is a todo app that stores items in localStorage."));
    work.turnEnded("agentroom-turn-1");

    work.observe(turnCompleted(CHILD, "child-turn", "completed"));
    await flush();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.afterRunId).toBe("agentroom-turn-1");
    expect(turns[0]?.finished).toEqual([{ id: CHILD, status: "completed", description: "readme reader" }]);
    expect(await turns[0]?.events("agent-turn-1")).toEqual([
      { type: "agent_update", message: "It is a todo app that stores items in localStorage." },
      { type: "run_succeeded", message: "Codex subagent finished" }
    ]);
  });

  it("posts nothing for a subagent that is stopped or was nested", async () => {
    const { work, turns } = setUp({ "thread/backgroundTerminals/list": { data: [], nextCursor: null } });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/a"));
    work.observe(turnStarted(CHILD, "child-turn"));
    work.observe(spawned(CHILD, "child-turn", GRANDCHILD, "/root/a/b"));
    work.observe(turnStarted(GRANDCHILD, "grandchild-turn"));
    work.observe(reply(GRANDCHILD, "grandchild-turn", "nested result"));
    work.observe(turnCompleted(GRANDCHILD, "grandchild-turn", "completed"));

    work.observe(reply(CHILD, "child-turn", "cut short"));
    work.observe(turnCompleted(CHILD, "child-turn", "interrupted"));
    await flush();

    expect(turns).toEqual([]);
  });

  it("holds the reply of a subagent that finishes during a session turn until that turn ends", async () => {
    const { work, turns, setBusy } = setUp({ "thread/backgroundTerminals/list": { data: [], nextCursor: null } });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/a"));
    work.observe(turnStarted(CHILD, "child-turn"));

    setBusy(true);
    work.observe(reply(CHILD, "child-turn", "finished mid-turn"));
    work.observe(turnCompleted(CHILD, "child-turn", "completed"));
    await flush();
    expect(turns).toEqual([]);

    setBusy(false);
    work.turnEnded("agentroom-turn-2");
    await flush();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.afterRunId).toBe("agentroom-turn-2");
    expect((await turns[0]?.events("agent-turn-1"))?.[0]).toEqual({ type: "agent_update", message: "finished mid-turn" });
  });

  it("posts subagents that finish in the same tick as one turn", async () => {
    const { work, turns } = setUp({ "thread/backgroundTerminals/list": { data: [], nextCursor: null } });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/first"));
    work.observe(spawned(PARENT, "parent-turn", GRANDCHILD, "/root/second"));
    work.observe(turnStarted(CHILD, "child-turn"));
    work.observe(turnStarted(GRANDCHILD, "other-turn"));

    work.observe(reply(CHILD, "child-turn", "one"));
    work.observe(turnCompleted(CHILD, "child-turn", "completed"));
    work.observe(reply(GRANDCHILD, "other-turn", "two"));
    work.observe(turnCompleted(GRANDCHILD, "other-turn", "completed"));
    await flush();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.finished.map((task) => task.description)).toEqual(["first", "second"]);
    expect((await turns[0]?.events("agent-turn-1"))?.[0]).toEqual({ type: "agent_update", message: "**first**\n\none\n\n**second**\n\ntwo" });
  });

  it("posts the error, marked as Codex's, when a subagent's turn fails", async () => {
    const { work, turns } = setUp({ "thread/backgroundTerminals/list": { data: [], nextCursor: null } });
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/a"));
    work.observe(turnStarted(CHILD, "child-turn"));

    work.observe({ method: "turn/completed", params: { threadId: CHILD, turn: { id: "child-turn", status: "failed", items: [], error: { message: "model overloaded" } } } });
    await flush();

    expect(turns[0]?.finished).toEqual([{ id: CHILD, status: "failed", description: "a" }]);
    expect(await turns[0]?.events("agent-turn-1")).toEqual([
      { type: "agent_update", message: "The subagent failed: model overloaded" },
      { type: "run_succeeded", message: "Codex subagent finished" }
    ]);
  });

  it("empties the list when the child process goes", () => {
    const { work, reports } = setUp();
    work.observe(spawned(PARENT, "parent-turn", CHILD, "/root/sleep_task"));

    work.reset();

    expect(reports.at(-1)).toEqual([]);
    expect(work.hasLiveTasks).toBe(false);
  });
});

interface PostedTurn {
  afterRunId?: string;
  finished: AgentFinishedBackgroundTask[];
  events(runId: string): Promise<AgentRunnerEvent[]>;
}

function setUp(replies: Record<string, unknown> = {}) {
  const reports: AgentBackgroundTask[][] = [];
  const requests: Array<[string, Record<string, unknown>]> = [];
  const turns: PostedTurn[] = [];
  let busy = false;
  const work = new CodexBackgroundWork({
    sessionId: "session-1",
    threadId: () => PARENT,
    busy: () => busy,
    request: async (method, params) => {
      requests.push([method, params]);
      if (!(method in replies)) throw new Error(`unexpected ${method}`);
      const answer = replies[method];
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    },
    listener: () => ({
      tasksChanged: ({ tasks }) => reports.push(tasks),
      turnStarted: ({ afterRunId, finished, start }) => turns.push({
        ...(afterRunId ? { afterRunId } : {}),
        finished,
        events: async (runId) => {
          const events: AgentRunnerEvent[] = [];
          for await (const event of start(runId)) events.push(event);
          return events;
        }
      })
    })
  });
  return { work, reports, requests, turns, setBusy: (value: boolean) => { busy = value; } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function reply(threadId: string, turnId: string, text: string): JsonRpcNotification {
  return { method: "item/completed", params: { threadId, turnId, completedAtMs: 1_800, item: { type: "agentMessage", id: `msg-${text.length}`, text, phase: null } } };
}

function spawned(threadId: string, turnId: string, agentThreadId: string, agentPath: string): JsonRpcNotification {
  return {
    method: "item/started",
    params: { threadId, turnId, startedAtMs: 1_000, item: { type: "subAgentActivity", id: `call-${agentThreadId}`, kind: "started", agentThreadId, agentPath } }
  };
}

function finished(threadId: string, turnId: string, agentThreadId: string): JsonRpcNotification {
  return {
    method: "item/completed",
    params: { threadId, turnId, completedAtMs: 2_000, item: { type: "subAgentActivity", id: `subagent-completed-${agentThreadId}`, kind: "completed", agentThreadId, agentPath: "/root/x" } }
  };
}

function turnStarted(threadId: string, turnId: string): JsonRpcNotification {
  return { method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } };
}

function turnCompleted(threadId: string, turnId: string, status: string): JsonRpcNotification {
  return { method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [], error: null } } };
}

function command(threadId: string, turnId: string): JsonRpcNotification {
  return {
    method: "item/started",
    params: { threadId, turnId, startedAtMs: 1_500, item: { type: "commandExecution", id: "exec-1", command: "/bin/zsh -lc 'sleep 20'", processId: "30934", status: "inProgress" } }
  };
}
