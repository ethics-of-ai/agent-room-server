import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackgroundTask, AgentFinishedBackgroundTask } from "../src/domain/backgroundWork";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { config } from "./support/agentSessionHarness";

// The pinned runtime with its real job registry, subagents, and AgentRoom's
// compiled Cordis plugin; only the model is scripted, so nothing leaves the Mac.
const checkout = process.env.DEEPSEEK_HARNESS_CHECKOUT;
const roots: string[] = [];
const runners: DeepSeekHarnessRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  delete process.env.AGENTROOM_PROBE_LLM_MODULE;
  delete process.env.AGENTROOM_BACKGROUND_LLM_SCRIPT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Reply = { tool: { name: string; arguments: Record<string, unknown> } } | { text: string };

async function managedRunner(scripts: Record<string, Reply[]>) {
  const root = await mkdtemp(join(tmpdir(), "agentroom-managed-background-"));
  roots.push(root);
  const source = join(root, "cordis.patch.yml");
  await writeFile(source, "# operator file, unused by managed setup\n");
  const route = join(root, "background-llm.patch.yml");
  await writeFile(route, [
    "- insert:",
    "    - id: background-llm",
    `      name: ${JSON.stringify(resolve("test/fixtures/deepseek/agentRoomBackgroundLlm.mjs"))}`,
    ""
  ].join("\n"));
  process.env.AGENTROOM_PROBE_LLM_MODULE = pathToFileURL(join(resolve(checkout!), "packages/llm/llm/lib/index.js")).href;
  process.env.AGENTROOM_BACKGROUND_LLM_SCRIPT = JSON.stringify(scripts);
  const runner = new DeepSeekHarnessRunner(await config({
    stateDir: join(root, "state"), workspaceRoot: root, deepseekExecutable: process.execPath,
    deepseekArgs: [join(resolve(checkout!), "apps/cli/lib/bin.js"), "--patch", route],
    deepseekCordisConfig: source, deepseekCompositionMode: "managed", deepseekProvider: "agentroom-background",
    deepseekModel: "probe", clarifyingQuestionsEnabled: false
  }));
  runners.push(runner);
  const lists: AgentBackgroundTask[][] = [];
  const turns: Array<{ finished: AgentFinishedBackgroundTask[]; events: AgentRunnerEvent[]; done: Promise<void> }> = [];
  runner.watchBackgroundWork({
    tasksChanged: ({ tasks }) => { lists.push(tasks); },
    turnStarted: (input) => {
      const turn = { finished: input.finished, events: [] as AgentRunnerEvent[], done: Promise.resolve() };
      const events = input.start(`agent-turn-${turns.length + 1}`);
      turn.done = (async () => { for await (const event of events) turn.events.push(event); })();
      turns.push(turn);
    }
  });
  const run = async (runId: string, prompt: string) => {
    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({ runId, sessionId: "session-1", workspacePath: root, prompt })) events.push(event);
    return events;
  };
  return { runner, lists, turns, run };
}

async function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const texts = (events: AgentRunnerEvent[]) => events.flatMap((event) => event.type === "agent_update" ? [event.message] : []);

describe.skipIf(!checkout)("managed DeepSeek background work on the real runtime", () => {
  it("lists a background shell job and opens the turn the runtime starts when it ends", async () => {
    const { lists, turns, run } = await managedRunner({
      "BG-JOB": [
        { tool: { name: "bash", arguments: { command: "sleep 1 && echo BG_DONE", description: "Wait", run_in_background: true } } },
        { text: "started" },
        { text: "the job finished" }
      ]
    });

    expect((await run("turn-1", "BG-JOB")).at(-1)).toEqual({ type: "run_succeeded" });
    await until(() => turns.length === 1);
    await turns[0]!.done;

    expect(lists[0]).toEqual([expect.objectContaining({ kind: "shell", description: "sleep 1 && echo BG_DONE" })]);
    expect(lists.at(-1)).toEqual([]);
    expect(turns[0]!.finished).toEqual([expect.objectContaining({ description: "sleep 1 && echo BG_DONE", status: "completed" })]);
    expect(texts(turns[0]!.events)).toEqual(["the job finished"]);
    expect(turns[0]!.events.at(-1)).toEqual({ type: "run_succeeded" });
  }, 30_000);

  it("stops a background job and a subagent, and the runtime tells the agent", async () => {
    const { runner, lists, turns, run } = await managedRunner({
      "STOP-PARENT": [
        { tool: { name: "bash", arguments: { command: "sleep 60", description: "Wait", run_in_background: true } } },
        { tool: { name: "subagent", arguments: { description: "Slow helper", prompt: "STOP-CHILD wait a minute" } } },
        { text: "both started" },
        { text: "noted the stop" },
        { text: "noted the second stop" }
      ],
      "STOP-CHILD": [
        { tool: { name: "bash", arguments: { command: "sleep 60", description: "Wait" } } },
        { text: "child done" }
      ]
    });

    await run("turn-1", "STOP-PARENT");
    await until(() => (lists.at(-1)?.length ?? 0) === 2);
    const [subagent, job] = lists.at(-1)!;
    expect(subagent).toMatchObject({ kind: "agent", description: "Slow helper" });
    expect(job).toMatchObject({ kind: "shell", description: "sleep 60" });

    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: job!.id })).toBe("stopped");
    await until(() => turns.length === 1);
    await turns[0]!.done;
    expect(turns[0]!.finished).toEqual([expect.objectContaining({ id: job!.id, status: "stopped" })]);

    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: subagent!.id })).toBe("stopped");
    await until(() => turns.length === 2);
    await turns[1]!.done;
    expect(turns[1]!.finished).toEqual([expect.objectContaining({ id: subagent!.id, description: "Slow helper", status: "stopped" })]);
    expect(lists.at(-1)).toEqual([]);
    expect(await runner.stopBackgroundTask({ sessionId: "session-1", taskId: job!.id })).toBe("unknown_task");
  }, 60_000);

  it("refuses new subagents once the agent has started three turns in a row on its own", async () => {
    const spawn = (n: number): Reply => ({ tool: { name: "subagent", arguments: { description: `Kid ${n}`, prompt: "SPAWNED-KID" } } });
    const { lists, turns, run } = await managedRunner({
      "LOOP-PARENT": [spawn(1), { text: "1" }, spawn(2), { text: "2" }, spawn(3), { text: "3" }, spawn(4), { text: "4" }, spawn(5), { text: "5" }],
      "SPAWNED-KID": [{ text: "kid done" }]
    });

    await run("turn-1", "LOOP-PARENT");
    // The pause is sent when the third agent turn opens, so that turn's call
    // may still race ahead of it; the fourth turn's call cannot.
    await until(() => turns.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await Promise.all(turns.map((turn) => turn.done));

    // Unpaused, every agent turn would start the next kid and wake again.
    const started = new Set(lists.flat().map((task) => task.description));
    expect(turns.length).toBeLessThanOrEqual(4);
    expect(started.has("Kid 3")).toBe(true);
    expect(started.has("Kid 5")).toBe(false);
    expect(lists.at(-1)).toEqual([]);
  }, 60_000);
});
