import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import { CodexBackgroundShells } from "../src/runner/codex/backgroundShells";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentBackgroundTask } from "../src/domain/backgroundWork";
import type { AgentRunnerBackgroundListener, AgentRunnerEvent } from "../src/runner/AgentRunner";

const SESSION_ID = "agentroom-session-bg";
const SHELL_STARTED_AT_MS = 1_790_000_000_000;

const runners: CodexAppServerRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
});

describe("Codex app-server thread routing", () => {
  it("keeps a subagent thread's turn events out of the parent turn", async () => {
    const { runner } = await setUp();

    const events = await runTurn(runner, "agentroom-turn-1");

    // The child's turn/completed arrives first; it must not end the parent's turn.
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });
    expect(messages(events)).toEqual(["parent reply"]);
    expect(events.some((event) => JSON.stringify(event).includes("codex-child-thread"))).toBe(false);
  });

  it("does not let a finished turn's trailing events end the next turn", async () => {
    const { runner } = await setUp();
    await runTurn(runner, "agentroom-turn-1");

    // The fake replays turn 1's turn/completed before answering turn/start.
    const events = await runTurn(runner, "agentroom-turn-2");

    expect(messages(events)).toEqual(["second reply"]);
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "Codex app-server turn completed" });
  });

  it("interrupts the running turn by its own id when a stray event named another turn first", async () => {
    const { runner, interruptLog } = await setUp(["turn-2-hangs"]);
    await runTurn(runner, "agentroom-turn-1");

    const second = runTurn(runner, "agentroom-turn-2");
    // Let the stray event and the turn/start answer land before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runner.cancel("agentroom-turn-2");
    await second;

    expect((await readFile(interruptLog, "utf8")).trim()).toBe("turn-2");
  });
});

describe("Codex background shells", () => {
  it("lists a shell that outlives its turn, with the command's start time", async () => {
    const { runner, reports } = await setUp();

    await runTurn(runner, "agentroom-turn-1");

    await waitFor(() => reports.length > 0);
    expect(reports.at(-1)).toEqual([{
      id: "cmd-1",
      kind: "shell",
      description: "sleep 30 && echo done",
      startedAt: new Date(SHELL_STARTED_AT_MS).toISOString()
    }]);
  });

  it("stops a listed shell and drops it when its end arrives", async () => {
    const { runner, reports } = await setUp();
    await runTurn(runner, "agentroom-turn-1");
    await waitFor(() => reports.length > 0);

    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "cmd-unknown" })).resolves.toBe("unknown_task");
    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "cmd-1" })).resolves.toBe("stopped");

    await waitFor(() => reports.at(-1)?.length === 0);
    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "cmd-1" })).resolves.toBe("unknown_task");
  });

  it("keeps a listed shell's late events out of the next turn", async () => {
    const { runner, reports } = await setUp(["shell-ends-in-turn-2"]);
    await runTurn(runner, "agentroom-turn-1");
    await waitFor(() => reports.length > 0);

    const events = await runTurn(runner, "agentroom-turn-2");

    expect(events.some((event) => JSON.stringify(event).includes("cmd-1"))).toBe(false);
    expect(messages(events)).toEqual(["second reply"]);
    await waitFor(() => reports.at(-1)?.length === 0);
  });

  it("keeps the child alive past the idle window while a shell runs", async () => {
    const { runner, reports } = await setUp([], { idleSessionTimeoutMs: 50 });
    await runTurn(runner, "agentroom-turn-1");
    await waitFor(() => reports.length > 0);

    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "cmd-1" })).resolves.toBe("stopped");
  });

  it("keeps the child alive past the idle window while a subagent runs", async () => {
    const { runner, reports } = await setUp(["subagent", "no-shell"], { idleSessionTimeoutMs: 50 });
    await runTurn(runner, "agentroom-turn-1");
    await waitFor(() => reports.at(-1)?.some((task) => task.kind === "agent") === true);

    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "codex-sub-thread" })).resolves.toBe("stopped");
  });

  it("empties the list when the app-server exits", async () => {
    const { runner, reports } = await setUp(["exit-after-list"]);
    await runTurn(runner, "agentroom-turn-1");

    await waitFor(() => reports.length >= 2);
    expect(reports.at(-2)).toHaveLength(1);
    expect(reports.at(-1)).toEqual([]);
  });

  it("does not list a shell whose end arrived while the list was being read", async () => {
    const { runner, reports } = await setUp(["shell-ends-during-list"]);

    await runTurn(runner, "agentroom-turn-1");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(reports).toEqual([]);
  });
});

describe("Codex subagents through the runner", () => {
  it("lists a spawned subagent, keeps its thread out of the turn, and stops it", async () => {
    const { runner, reports } = await setUp(["subagent"]);

    const events = await runTurn(runner, "agentroom-turn-1");

    expect(events.some((event) => JSON.stringify(event).includes("sub reply"))).toBe(false);
    await waitFor(() => reports.at(-1)?.some((task) => task.id === "codex-sub-thread") === true);
    expect(reports.at(-1)?.find((task) => task.kind === "agent")?.description).toBe("sleep task");

    await expect(runner.stopBackgroundTask({ sessionId: SESSION_ID, taskId: "codex-sub-thread" })).resolves.toBe("stopped");
    await waitFor(() => reports.at(-1)?.every((task) => task.kind !== "agent") === true);
  });

  it("hands the service the reply of a subagent that finished during the session's turn once it settles", async () => {
    const { runner, agentTurns } = await setUp(["subagent", "subagent-finishes-in-turn"]);

    await runTurn(runner, "agentroom-turn-1");

    await waitFor(() => agentTurns.length > 0);
    expect(agentTurns[0]?.afterRunId).toBe("agentroom-turn-1");
    const events: AgentRunnerEvent[] = [];
    for await (const event of agentTurns[0]!.start("agent-turn-1")) events.push(event);
    expect(events[0]).toEqual({ type: "agent_update", message: "sub result" });
  });

  it("hands the service a turn holding the reply of a subagent that finished after the session's turn", async () => {
    const { runner, agentTurns } = await setUp(["subagent", "subagent-finishes"]);

    await runTurn(runner, "agentroom-turn-1");

    await waitFor(() => agentTurns.length > 0);
    expect(agentTurns[0]?.afterRunId).toBe("agentroom-turn-1");
    expect(agentTurns[0]?.finished).toEqual([{ id: "codex-sub-thread", status: "completed", description: "sleep task" }]);
    const events: AgentRunnerEvent[] = [];
    for await (const event of agentTurns[0]!.start("agent-turn-1")) events.push(event);
    expect(events).toEqual([
      { type: "agent_update", message: "sub result" },
      { type: "run_succeeded", message: "Codex subagent finished" }
    ]);
  });
});

describe("Codex background shell list replies", () => {
  it("redacts a command line's credentials and skips a malformed terminal", async () => {
    // Built at run time so the public mirror's secret scan does not read a curl bearer header.
    const token = ["sk", "live", "123"].join("-");
    const reports: AgentBackgroundTask[][] = [];
    const shells = new CodexBackgroundShells({
      threadId: () => "thread-1",
      request: async () => ({
        data: [
          { itemId: "cmd-1", processId: "proc-1", command: `curl -H 'Authorization: Bearer ${token}' https://example.test` },
          { itemId: "cmd-2", processId: 42, command: "sleep 5" }
        ],
        nextCursor: null
      }),
      report: (tasks) => reports.push(tasks)
    });

    await shells.refresh();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.map((task) => task.id)).toEqual(["cmd-1"]);
    expect(reports[0]?.[0]?.description).not.toContain(token);
  });

  it("keeps the current list when a reply does not match the schema", async () => {
    let reply: unknown = { data: [{ itemId: "cmd-1", processId: "proc-1", command: "sleep 30" }], nextCursor: null };
    const reports: AgentBackgroundTask[][] = [];
    const shells = new CodexBackgroundShells({ threadId: () => "thread-1", request: async () => reply, report: (tasks) => reports.push(tasks) });
    await shells.refresh();

    reply = { data: "not a list" };
    await shells.refresh();

    expect(reports).toHaveLength(1);
    expect(shells.list().map((task) => task.id)).toEqual(["cmd-1"]);
    reply = { terminated: "yes" };
    await expect(shells.stop("cmd-1")).resolves.toBe("unknown_task");
  });
});

async function setUp(flags: string[] = [], deps: { idleSessionTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentroom-codex-bg-"));
  const serviceConfig: ServiceConfig = {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [await writeFakeAppServer(root), flags.join(","), join(root, "interrupts.log")],
    codexRunnerProtocol: "jsonrpc"
  } as ServiceConfig;
  const runner = new CodexAppServerRunner(serviceConfig, deps);
  runners.push(runner);
  const reports: AgentBackgroundTask[][] = [];
  const agentTurns: Array<Parameters<AgentRunnerBackgroundListener["turnStarted"]>[0]> = [];
  runner.watchBackgroundWork({
    tasksChanged: ({ tasks }) => reports.push(tasks),
    turnStarted: (input) => agentTurns.push(input)
  });
  return { runner, reports, agentTurns, interruptLog: join(root, "interrupts.log") };
}

async function runTurn(runner: CodexAppServerRunner, runId: string): Promise<AgentRunnerEvent[]> {
  const events: AgentRunnerEvent[] = [];
  for await (const event of runner.run({ runId, sessionId: SESSION_ID, workspacePath: tmpdir(), prompt: runId, title: runId })) {
    events.push(event);
  }
  return events;
}

function messages(events: AgentRunnerEvent[]): string[] {
  return events.flatMap((event) => event.type === "agent_update" ? [event.message] : []);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Turn 1 spawns a subagent thread that finishes first, starts `cmd-1` as a
 * unified-exec shell that outlives the turn, and replies. Turn 2 first
 * replays turn 1's `turn/completed`, then replies. With `turn-2-hangs`, turn 2
 * instead sends an event naming a stray turn before answering `turn/start`,
 * never completes, and logs the turn id it is asked to interrupt.
 */
async function writeFakeAppServer(root: string): Promise<string> {
  const path = join(root, "fake-codex-background.cjs");
  await writeFile(path, `
const readline = require("node:readline");
const fs = require("node:fs");
const flags = (process.argv[2] || "").split(",");
const interruptLog = process.argv[3];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const threadId = "codex-thread-bg";
const subThread = "codex-sub-thread";
const turn = (id, status) => ({ id, status, items: [], error: null });
const command = (status) => ({ type: "commandExecution", id: "cmd-1", command: "sleep 30 && echo done", cwd: "/tmp", processId: null, source: "unifiedExecStartup", status });
let turns = 0;
let shellAlive = !flags.includes("no-shell");

function endShell() {
  if (!shellAlive) return;
  shellAlive = false;
  send({ method: "item/completed", params: { threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { ...command("completed"), exitCode: 0 } } });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
  } else if (message.method === "turn/start") {
    turns += 1;
    if (turns === 1) {
      send({ id: message.id, result: { turn: turn("turn-1", "inProgress") } });
      send({ method: "turn/started", params: { threadId, turn: turn("turn-1", "inProgress") } });
      if (flags.includes("subagent")) {
        send({ method: "item/started", params: { threadId, turnId: "turn-1", startedAtMs: Date.now(), item: { type: "subAgentActivity", id: "call-sub", kind: "started", agentThreadId: subThread, agentPath: "/root/sleep_task" } } });
        send({ method: "turn/started", params: { threadId: subThread, turn: turn("sub-turn", "inProgress") } });
        send({ method: "item/agentMessage/delta", params: { threadId: subThread, turnId: "sub-turn", itemId: "sub-msg", delta: "sub reply" } });
        if (flags.includes("subagent-finishes-in-turn")) {
          send({ method: "item/completed", params: { threadId: subThread, turnId: "sub-turn", item: { type: "agentMessage", id: "sub-msg", text: "sub result", phase: null } } });
          send({ method: "turn/completed", params: { threadId: subThread, turn: turn("sub-turn", "completed") } });
        }
      }
      send({ method: "turn/started", params: { threadId: "codex-child-thread", turn: turn("child-turn", "inProgress") } });
      send({ method: "item/agentMessage/delta", params: { threadId: "codex-child-thread", turnId: "child-turn", itemId: "child-msg", delta: "child reply" } });
      send({ method: "turn/completed", params: { threadId: "codex-child-thread", turn: turn("child-turn", "completed") } });
      if (shellAlive) send({ method: "item/started", params: { threadId, turnId: "turn-1", startedAtMs: ${SHELL_STARTED_AT_MS}, item: command("inProgress") } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", itemId: "msg-1", delta: "parent reply" } });
      send({ method: "turn/completed", params: { threadId, turn: turn("turn-1", "completed") } });
      if (flags.includes("subagent-finishes")) setTimeout(() => {
        send({ method: "item/completed", params: { threadId: subThread, turnId: "sub-turn", item: { type: "agentMessage", id: "sub-msg", text: "sub result", phase: null } } });
        send({ method: "turn/completed", params: { threadId: subThread, turn: turn("sub-turn", "completed") } });
      }, 100);
      return;
    }
    send({ method: "turn/completed", params: { threadId, turn: turn("turn-1", "completed") } });
    if (flags.includes("turn-2-hangs")) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-stray", itemId: "msg-stray", delta: "stray" } });
      send({ id: message.id, result: { turn: turn("turn-2", "inProgress") } });
      send({ method: "turn/started", params: { threadId, turn: turn("turn-2", "inProgress") } });
      return;
    }
    send({ id: message.id, result: { turn: turn("turn-2", "inProgress") } });
    send({ method: "turn/started", params: { threadId, turn: turn("turn-2", "inProgress") } });
    if (flags.includes("shell-ends-in-turn-2")) {
      send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId: "turn-1", itemId: "cmd-1", delta: "done" } });
      endShell();
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-2", itemId: "msg-2", delta: "second reply" } });
    send({ method: "turn/completed", params: { threadId, turn: turn("turn-2", "completed") } });
  } else if (message.method === "turn/interrupt" && message.params.threadId === subThread) {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: subThread, turn: turn("sub-turn", "interrupted") } });
  } else if (message.method === "turn/interrupt") {
    fs.appendFileSync(interruptLog, message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: turn(message.params.turnId, "interrupted") } });
  } else if (message.method === "thread/backgroundTerminals/list" && message.params.threadId === subThread) {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/backgroundTerminals/list") {
    if (flags.includes("shell-ends-during-list")) endShell();
    const data = flags.includes("shell-ends-during-list") || shellAlive
      ? [{ itemId: "cmd-1", processId: "proc-1", command: "sleep 30 && echo done", cwd: "/tmp", osPid: null, cpuPercent: null, rssKb: null }]
      : [];
    send({ id: message.id, result: { data, nextCursor: null } });
    if (flags.includes("exit-after-list")) setTimeout(() => process.exit(0), 50);
  } else if (message.method === "thread/backgroundTerminals/terminate") {
    const terminated = message.params.processId === "proc-1" && shellAlive;
    send({ id: message.id, result: { terminated } });
    if (terminated) setTimeout(endShell, 10);
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}
