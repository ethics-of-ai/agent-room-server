import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import { backgroundTurnMessage } from "../src/agent/AgentBackgroundWork";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentBackgroundTask } from "../src/domain/backgroundWork";
import type { AgentRunner, AgentRunnerBackgroundListener, AgentRunnerEvent } from "../src/runner/AgentRunner";
import { config, waitForEvent, waitForSession, waitForSessionWhere } from "./support/agentSessionHarness";

/**
 * A runner whose background work the test drives by hand: it reports task
 * lists, starts agent turns, and holds each agent turn open until the test
 * finishes it.
 */
function backgroundRunner() {
  let listener: AgentRunnerBackgroundListener | undefined;
  const stopped: string[] = [];
  let agentTurn: AsyncEventQueue<AgentRunnerEvent> | undefined;
  let agentRunId: string | undefined;
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield { type: "run_succeeded", message: "launched" };
    },
    async cancel() {
      agentTurn?.push({ type: "run_failed", error: "interrupted" });
      agentTurn?.close();
    },
    watchBackgroundWork(next) {
      listener = next;
    },
    async stopBackgroundTask({ taskId }) {
      if (taskId === "task-unstoppable") return "unavailable";
      if (taskId !== "task-1") return "unknown_task";
      stopped.push(taskId);
      return "stopped";
    }
  };
  return {
    runner,
    stopped,
    get agentRunId() {
      return agentRunId;
    },
    report(sessionId: string, tasks: AgentBackgroundTask[]) {
      listener!.tasksChanged({ sessionId, tasks });
    },
    /** Starts an agent turn; true when the service accepted it. */
    startAgentTurn(sessionId: string, afterRunId?: string): boolean {
      let accepted = false;
      listener!.turnStarted({
        sessionId,
        ...(afterRunId ? { afterRunId } : {}),
        finished: [{ id: "task-1", status: "completed", description: "Review backend standards", summary: "Two breaches" }],
        start: (runId) => {
          accepted = true;
          agentRunId = runId;
          const queue = new AsyncEventQueue<AgentRunnerEvent>();
          agentTurn = queue;
          return queue;
        }
      });
      return accepted;
    },
    finishAgentTurn(message: string) {
      agentTurn!.push({ type: "agent_update", message });
      agentTurn!.push({ type: "run_succeeded", message });
      agentTurn!.close();
    }
  };
}

const task: AgentBackgroundTask = {
  id: "task-1",
  kind: "agent",
  description: "Review backend standards",
  progress: "Reading the standards",
  startedAt: "2026-10-13T17:00:00.000Z"
};

async function sessionWithLaunchTurn(serviceConfig: ServiceConfig, fake: ReturnType<typeof backgroundRunner>) {
  const { app, eventBus } = await buildServer({ config: serviceConfig, runners: { codex: fake.runner } });
  const auth = serviceConfig.authToken ? { authorization: `Bearer ${serviceConfig.authToken}` } : undefined;
  const directory = await mkdtemp(join(tmpdir(), "agentroom-background-"));
  const workspace = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: directory }, headers: auth });
  const created = await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.json().workspace.id, runnerKind: "codex" }, headers: auth });
  const sessionId = created.json().session.id as string;
  await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "Review in the background" }, headers: auth });
  await waitForSession({ inject: (input) => app.inject({ ...input, headers: auth }) }, sessionId, "idle");
  return { app, eventBus, sessionId, auth };
}

describe("background work", () => {
  it("shows the live task list on the session and broadcasts it outside the replay buffer", async () => {
    const serviceConfig = await config();
    const fake = backgroundRunner();
    const { app, eventBus, sessionId } = await sessionWithLaunchTurn(serviceConfig, fake);
    const broadcast: Array<{ type: string; payload: any }> = [];
    eventBus.subscribe((event) => broadcast.push(event));

    fake.report(sessionId, [task]);
    const session = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` })).json().session;
    expect(session.status).toBe("idle");
    expect(session.backgroundTasks).toEqual([task]);
    expect(broadcast).toEqual([
      expect.objectContaining({ type: "agent_background_tasks_changed", payload: { sessionId, workspaceId: session.workspaceId, tasks: [task] } })
    ]);
    expect(eventBus.getRecentEvents(200).some((event) => event.type === "agent_background_tasks_changed")).toBe(false);

    fake.report(sessionId, []);
    const cleared = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` })).json().session;
    expect(cleared.backgroundTasks).toBeUndefined();
    await app.close();
  });

  it("records an agent-started turn with its trigger, and refuses a person's turn until it settles", async () => {
    const serviceConfig = await config();
    const fake = backgroundRunner();
    const { app, eventBus, sessionId } = await sessionWithLaunchTurn(serviceConfig, fake);
    fake.report(sessionId, [task]);

    expect(fake.startAgentTurn(sessionId)).toBe(true);
    const started = (await waitForEvent(eventBus, "agent_turn_started")).payload;
    const agentStarted = eventBus.getRecentEvents(200).filter((event) => event.type === "agent_turn_started").at(-1)!.payload as any;
    expect(started.trigger).toBeUndefined();
    expect(agentStarted.trigger).toEqual({
      kind: "background_task",
      tasks: [{ id: "task-1", status: "completed", description: "Review backend standards", summary: "Two breaches" }]
    });

    const running = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` })).json().session;
    expect(running).toMatchObject({ status: "running", activeTurnId: agentStarted.turnId });
    const refused = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "Status?" } });
    expect(refused.statusCode).toBe(409);
    // A second agent turn cannot open over the first either, unless the
    // runner says the first has already ended.
    expect(fake.startAgentTurn(sessionId)).toBe(false);
    expect(fake.startAgentTurn(sessionId, "an-older-turn")).toBe(false);

    fake.finishAgentTurn("The review is back.");
    const settled = await waitForSessionWhere(app, sessionId, (session) => session.status === "idle" && session.turnCount === 2, "the agent turn to settle");
    expect(settled.lastMessage).toBe("The review is back.");

    const messages = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).json().messages;
    const agentTurnMessages = messages.filter((message: any) => message.turnId === agentStarted.turnId);
    expect(agentTurnMessages.map((message: any) => [message.role, message.content])).toEqual([
      ["system", "Background task finished: Review backend standards"],
      ["assistant", "The review is back."]
    ]);
    expect(eventBus.getRecentEvents(200).map((event) => event.type)).toContain("agent_turn_succeeded");
    await app.close();
  });

  it("holds an agent turn that starts while the previous one settles, then opens it", async () => {
    const serviceConfig = await config();
    const fake = backgroundRunner();
    const { app, eventBus, sessionId } = await sessionWithLaunchTurn(serviceConfig, fake);
    expect(fake.startAgentTurn(sessionId)).toBe(true);
    const first = fake.agentRunId!;

    // The runner delivers the first turn's result and moves on to the next
    // notification before the service has settled the first turn.
    fake.finishAgentTurn("The first review is back.");
    expect(fake.startAgentTurn(sessionId, first)).toBe(true);
    const second = fake.agentRunId!;
    expect(second).not.toBe(first);
    const refused = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "Status?" } });
    expect(refused.statusCode).toBe(409);

    fake.finishAgentTurn("The second review is back.");
    const settled = await waitForSessionWhere(app, sessionId, (session) => session.status === "idle" && session.turnCount === 3, "both agent turns to settle");
    expect(settled.lastMessage).toBe("The second review is back.");
    const started = eventBus.getRecentEvents(200).filter((event) => event.type === "agent_turn_started").map((event) => (event.payload as any).turnId);
    expect(started.slice(-2)).toEqual([first, second]);
    await app.close();
  });

  it("never persists the live list", async () => {
    const serviceConfig = await config();
    const fake = backgroundRunner();
    const { app, sessionId } = await sessionWithLaunchTurn(serviceConfig, fake);
    fake.report(sessionId, [task]);
    expect(fake.startAgentTurn(sessionId)).toBe(true);
    fake.finishAgentTurn("Done.");
    await waitForSessionWhere(app, sessionId, (session) => session.turnCount === 2, "the agent turn to settle");
    await app.close();

    const document = JSON.parse(await readFile(join(serviceConfig.stateDir, "sessions", `${sessionId}.json`), "utf8"));
    expect(document.session.backgroundTasks).toBeUndefined();
    expect(document.turns.find((turn: any) => turn.trigger)?.trigger.kind).toBe("background_task");
  });

  it("stops a live task through the bearer-gated route", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const fake = backgroundRunner();
    const { app, sessionId, auth } = await sessionWithLaunchTurn(serviceConfig, fake);
    const url = `/api/agent-sessions/${sessionId}/background-tasks/task-1/stop`;

    expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
    const stopped = await app.inject({ method: "POST", url, headers: auth });
    expect(stopped.statusCode).toBe(200);
    expect(fake.stopped).toEqual(["task-1"]);
    const unknown = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/background-tasks/nope/stop`, headers: auth });
    expect(unknown.statusCode).toBe(404);
    const unstoppable = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/background-tasks/task-unstoppable/stop`, headers: auth });
    expect(unstoppable.statusCode).toBe(409);
    await app.close();
  });

  it("names what finished in the turn's opening line", () => {
    expect(backgroundTurnMessage({ kind: "background_task", tasks: [] })).toBe("Background work finished.");
    expect(backgroundTurnMessage({ kind: "background_task", tasks: [{ id: "a", status: "failed", description: "Build" }] }))
      .toBe("Background task failed: Build");
    expect(backgroundTurnMessage({
      kind: "background_task",
      tasks: [{ id: "a", status: "completed", description: "Build" }, { id: "b", status: "stopped" }]
    })).toBe("2 background tasks ended: Build; untitled");
  });
});
