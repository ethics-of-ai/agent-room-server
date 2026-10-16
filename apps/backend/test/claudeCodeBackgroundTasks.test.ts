import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentBackgroundTask, AgentFinishedBackgroundTask } from "../src/domain/backgroundWork";
import type { AgentRunnerBackgroundListener, AgentRunnerEvent } from "../src/runner/AgentRunner";

// SDK shapes below are trimmed from a 2026-10-13 wire capture against SDK
// 0.3.296 (see docs/plans/BACKGROUND_TASKS_PLAN.md, "Claude Code wire behavior").

const config = async (): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-claude-background-"));
  return {
    runnerKind: "claude_code",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: []
  };
};

class FakeQuery implements ClaudeCodeQuery {
  readonly output = new AsyncEventQueue<unknown>();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly stopped: string[] = [];
  returned = false;

  constructor(prompt: AsyncIterable<unknown>, readonly options: Record<string, unknown>, onSend: (message: Record<string, unknown>, query: FakeQuery) => void) {
    void (async () => {
      for await (const message of prompt) {
        this.sent.push(message as Record<string, unknown>);
        onSend(message as Record<string, unknown>, this);
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {}

  async stopTask(taskId: string): Promise<void> {
    this.stopped.push(taskId);
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.returned = true;
    this.output.close();
    return { value: undefined, done: true };
  }
}

/** Answers every send with one assistant line and a result that echoes its uuid. */
function echoingTurn(message: Record<string, unknown>, query: FakeQuery): void {
  const uuid = String(message.uuid);
  query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
  query.output.push(textDelta("started."));
  query.output.push({ type: "result", subtype: "success", result: "started.", session_id: "sdk-1", user_message_uuid: uuid, user_message_uuids: [uuid] });
}

function textDelta(text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    session_id: "sdk-1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } }
  };
}

function harness(onSend: (message: Record<string, unknown>, query: FakeQuery) => void = echoingTurn) {
  const queries: FakeQuery[] = [];
  const queryFunction: ClaudeCodeQueryFunction = ({ prompt, options }) => {
    const query = new FakeQuery(prompt, options, onSend);
    queries.push(query);
    return query;
  };
  return { loadQuery: async () => queryFunction, queries };
}

interface RecordedTurn {
  afterRunId?: string;
  finished: AgentFinishedBackgroundTask[];
  events: AgentRunnerEvent[];
  done: Promise<void>;
}

function recordingListener(options: { accept?: boolean } = {}) {
  const taskLists: AgentBackgroundTask[][] = [];
  const turns: RecordedTurn[] = [];
  const listener: AgentRunnerBackgroundListener = {
    tasksChanged: ({ tasks }) => taskLists.push(tasks),
    turnStarted: ({ afterRunId, finished, start }) => {
      if (options.accept === false) {
        turns.push({ afterRunId, finished, events: [], done: Promise.resolve() });
        return;
      }
      const events: AgentRunnerEvent[] = [];
      const iterable = start(`agent-turn-${turns.length + 1}`);
      const done = (async () => {
        for await (const event of iterable) events.push(event);
      })();
      turns.push({ afterRunId, finished, events, done });
    }
  };
  return { listener, taskLists, turns };
}

async function drain(events: AsyncIterable<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> {
  const collected: AgentRunnerEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const shellTask = { task_id: "b1", run_id: "r1", task_type: "local_bash", description: "Sleep then echo" };
const agentTask = { task_id: "a1", run_id: "r2", task_type: "local_agent", subagent_type: "general-purpose", description: "Review backend standards" };

function startFirstTurn(runner: ClaudeCodeRunner): Promise<AgentRunnerEvent[]> {
  return drain(runner.run({ runId: "turn-1", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Start the reviews" }));
}

describe("Claude Code background tasks", () => {
  it("sends each prompt with a uuid and asks for subagent progress summaries", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const events = await startFirstTurn(runner);

    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "started." });
    expect(typeof queries[0]!.sent[0]!.uuid).toBe("string");
    expect(queries[0]!.options.agentProgressSummaries).toBe(true);
  });

  it("reports the live list from the level signal, leaving out ambient tasks", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, taskLists } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;

    query.output.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [shellTask, agentTask, { task_id: "w1", task_type: "local_bash", description: "watcher", ambient: true }]
    });
    await waitFor(() => taskLists.length === 1);
    expect(taskLists[0]!.map(({ id, kind, description }) => ({ id, kind, description }))).toEqual([
      { id: "b1", kind: "shell", description: "Sleep then echo" },
      { id: "a1", kind: "agent", description: "Review backend standards" }
    ]);

    // Progress changes report once, after a short coalescing wait.
    query.output.push({ type: "system", subtype: "task_progress", task_id: "a1", description: "Running List files" });
    query.output.push({ type: "system", subtype: "task_progress", task_id: "a1", description: "Running Read README", summary: "Reading the backend standards" });
    query.output.push({ type: "system", subtype: "task_progress", task_id: "a1", description: "Running Grep" });
    await waitFor(() => taskLists.length === 2);
    expect(taskLists[1]!.find((task) => task.id === "a1")?.progress).toBe("Reading the backend standards");

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await waitFor(() => taskLists.length === 3);
    expect(taskLists[2]).toEqual([]);
  });

  it("turns the agent's own reply into a turn the service starts", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, turns } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [agentTask] });
    // A foreground tool's notification is not background work.
    query.output.push({ type: "system", subtype: "task_started", task_id: "f1", description: "Foreground ls", is_backgrounded: false });
    query.output.push({ type: "system", subtype: "task_notification", task_id: "f1", status: "completed", summary: "ls" });
    query.output.push({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "Found two standards breaches" });
    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
    query.output.push(textDelta("The review is back."));
    query.output.push({
      type: "result",
      subtype: "success",
      result: "The review is back.",
      session_id: "sdk-1",
      origin: { kind: "task-notification", producer: "session-task", runId: "r2" }
    });

    await waitFor(() => turns.length === 1);
    await turns[0]!.done;
    expect(turns[0]!.finished).toEqual([
      { id: "a1", status: "completed", description: "Review backend standards", summary: "Found two standards breaches" }
    ]);
    const events = turns[0]!.events;
    expect(events[0]).toMatchObject({ type: "runner_audit", audit: { phase: "started", runId: "agent-turn-1" } });
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_activity", activity: expect.objectContaining({ canonical: { kind: "turn_started" } }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_update", message: "The review is back." }));
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "The review is back." });

    // The next person's turn still routes by its own echo.
    const next = await drain(runner.run({ runId: "turn-2", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Thanks" }));
    expect(next.at(-1)).toEqual({ type: "run_succeeded", message: "started." });
  });

  it("keeps a notification that arrives during an agent turn for the next one", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, turns } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;
    const ownTurn = (text: string, runId: string) => {
      query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
      query.output.push(textDelta(text));
      query.output.push({ type: "result", subtype: "success", result: text, session_id: "sdk-1", origin: { kind: "task-notification", runId } });
    };

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [shellTask, agentTask] });
    query.output.push({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "exit 0" });
    query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
    // The second task ends while the agent answers the first; the CLI answers it in a turn of its own.
    query.output.push({ type: "system", subtype: "task_notification", task_id: "a1", status: "failed", summary: "crashed" });
    query.output.push({ type: "result", subtype: "success", result: "Shell done.", session_id: "sdk-1", origin: { kind: "task-notification", runId: "r1" } });
    ownTurn("Agent failed.", "r2");

    await waitFor(() => turns.length === 2);
    await Promise.all(turns.map((turn) => turn.done));
    expect(turns.map((turn) => turn.finished.map((task) => task.id))).toEqual([["b1"], ["a1"]]);
    // Each start names the turn before it, which the service may still be settling.
    expect(turns.map((turn) => turn.afterRunId)).toEqual(["turn-1", "agent-turn-1"]);
    expect(turns[1]!.events.at(-1)).toEqual({ type: "run_succeeded", message: "Agent failed." });
  });

  it("drops a refused agent turn's events and keeps serving the person's turns", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, turns } = recordingListener({ accept: false });
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;

    query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
    query.output.push(textDelta("Nobody hears this."));
    query.output.push({ type: "result", subtype: "success", result: "Nobody hears this.", session_id: "sdk-1", origin: { kind: "task-notification" } });
    await waitFor(() => turns.length === 1);

    const next = await drain(runner.run({ runId: "turn-2", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Hello" }));
    expect(next.at(-1)).toEqual({ type: "run_succeeded", message: "started." });
    expect(turns).toHaveLength(1);
  });

  it("routes a result by its echoed uuid when the CLI folded a send into its own turn", async () => {
    let sends = 0;
    const { loadQuery, queries } = harness((message, query) => {
      sends += 1;
      if (sends === 1) return echoingTurn(message, query);
      // The CLI queued this send behind its own turn and answered both at once.
      const uuid = String(message.uuid);
      query.output.push(textDelta("pong"));
      query.output.push({ type: "result", subtype: "success", result: "pong", session_id: "sdk-1", user_message_uuid: uuid, user_message_uuids: [uuid], origin: { kind: "task-notification" } });
    });
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener } = recordingListener({ accept: false });
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    queries[0]!.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = await drain(runner.run({ runId: "turn-2", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "ping" }));
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "pong" });
  });

  it("settles a follow-up whose result also echoes the interrupted send before it", async () => {
    const sendUuids: string[] = [];
    const { loadQuery } = harness((message, query) => {
      sendUuids.push(String(message.uuid));
      if (sendUuids.length === 1) return echoingTurn(message, query);
      if (sendUuids.length === 2) return;
      // The CLI answered the interrupted send and its follow-up in one result.
      query.output.push(textDelta("Did this instead."));
      query.output.push({
        type: "result",
        subtype: "success",
        result: "Did this instead.",
        session_id: "sdk-1",
        user_message_uuid: sendUuids[2],
        user_message_uuids: [sendUuids[1], sendUuids[2]]
      });
    });
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    await startFirstTurn(runner);

    const interrupted = drain(runner.run({ runId: "turn-2", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Long task" }));
    await waitFor(() => sendUuids.length === 2);
    await runner.cancel("turn-2");
    expect((await interrupted).at(-1)).toEqual({ type: "run_failed", error: "Claude Code turn interrupted" });

    const followUp = await drain(runner.run({ runId: "turn-3", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Do this instead" }));
    expect(followUp.at(-1)).toEqual({ type: "run_succeeded", message: "Did this instead." });
  });

  it("keeps a notification past an interrupted turn's trailing result for the agent turn that answers it", async () => {
    const sendUuids: string[] = [];
    const { loadQuery, queries } = harness((message, query) => {
      sendUuids.push(String(message.uuid));
      if (sendUuids.length === 1) echoingTurn(message, query);
    });
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, turns } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;

    const interrupted = drain(runner.run({ runId: "turn-2", sessionId: "session-1", workspacePath: "/tmp/workspace", prompt: "Long task" }));
    await waitFor(() => sendUuids.length === 2);
    await runner.cancel("turn-2");
    await interrupted;
    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [shellTask] });
    query.output.push({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "exit 0" });
    query.output.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sdk-1",
      user_message_uuid: sendUuids[1],
      user_message_uuids: [sendUuids[1]]
    });
    query.output.push({ type: "system", subtype: "init", session_id: "sdk-1" });
    query.output.push({ type: "result", subtype: "success", result: "Shell done.", session_id: "sdk-1", origin: { kind: "task-notification", runId: "r1" } });

    await waitFor(() => turns.length === 1);
    expect(turns[0]!.finished.map((task) => task.id)).toEqual(["b1"]);
  });

  it("starts a re-run under the same task id afresh", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, taskLists } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [agentTask] });
    query.output.push({ type: "system", subtype: "task_progress", task_id: "a1", summary: "Reading the standards" });
    await waitFor(() => taskLists.length === 2);
    const firstRun = taskLists[1]![0]!;
    expect(firstRun.progress).toBe("Reading the standards");
    await new Promise((resolve) => setTimeout(resolve, 5));

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ ...agentTask, run_id: "r3" }] });
    await waitFor(() => taskLists.length === 3);
    const rerun = taskLists[2]![0]!;
    expect(rerun.progress).toBeUndefined();
    expect(Date.parse(rerun.startedAt)).toBeGreaterThan(Date.parse(firstRun.startedAt));
  });

  it("keeps a child with live tasks from being reaped, and empties the list when it ends", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery, idleSessionTimeoutMs: 20 });
    const { listener, taskLists } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    const query = queries[0]!;
    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [shellTask] });
    await waitFor(() => taskLists.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(query.returned).toBe(false);

    query.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await waitFor(() => query.returned);
    expect(taskLists.at(-1)).toEqual([]);
  });

  it("stops a live task and refuses one it does not list", async () => {
    const { loadQuery, queries } = harness();
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const { listener, taskLists } = recordingListener();
    runner.watchBackgroundWork(listener);
    await startFirstTurn(runner);
    queries[0]!.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [shellTask] });
    await waitFor(() => taskLists.length === 1);

    await expect(runner.stopBackgroundTask({ sessionId: "session-1", taskId: "b1" })).resolves.toBe("stopped");
    await expect(runner.stopBackgroundTask({ sessionId: "session-1", taskId: "nope" })).resolves.toBe("unknown_task");
    await expect(runner.stopBackgroundTask({ sessionId: "other", taskId: "b1" })).resolves.toBe("unknown_task");
    expect(queries[0]!.stopped).toEqual(["b1"]);
  });
});
