import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { AgentSessionService } from "../src/agent/AgentSessionService";
import type { AgentRunner } from "../src/runner/AgentRunner";
import {
  config,
  registerWorkspaceOffline,
  sessionDocument,
  waitForSession,
  writeSessionDocument
} from "./support/agentSessionHarness";

/** A runner whose turn creates and executes a plan through the session's plan service. */
function planningRunner(sessions: () => AgentSessionService): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      const turn = { turnId: input.runId, isLive: () => true };
      const created = await sessions().plans.invoke(input.sessionId as string, "plans.create", {
        operationId: `create-${input.runId}`, objective: "Plan", completionCriteria: "Done", steps: [{ description: "Step" }]
      }, turn);
      if (!created.ok || !created.plan) throw new Error("create failed");
      await sessions().plans.invoke(input.sessionId as string, "plans.execute", {
        operationId: `execute-${input.runId}`, planId: created.plan.id, expectedRevision: created.plan.revision
      }, turn);
      yield { type: "run_succeeded", message: "planned" };
    },
    async cancel() {}
  };
}

async function sessionFile(stateDir: string, sessionId: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(stateDir, "sessions", `${sessionId}.json`), "utf8"));
}

describe("thread plans in agent sessions", () => {
  it("pauses a running plan when its turn ends and keeps plan text out of session summaries", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    let sessions!: AgentSessionService;
    const server = await buildServer({ config: serviceConfig, runners: { claude_code: planningRunner(() => sessions) } });
    sessions = server.agentSessions;
    const created = await server.app.inject({
      method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, runnerKind: "claude_code" }
    });
    const sessionId = created.json().session.id;
    await server.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "go" } });
    await waitForSession(server.app, sessionId, "idle");
    expect(await sessions.plans.prepareForTurn(sessionId)).toBe(true);
    await server.durableSessions.flush();

    const document = await sessionFile(serviceConfig.stateDir, sessionId);
    expect(document).toMatchObject({ schemaVersion: 2, plan: { revision: 3, status: "paused", pauseReason: "turn_ended", executionTurnId: null } });
    expect(document.session.plan).toBeUndefined();
    const status = await server.app.inject({ method: "GET", url: "/api/status" });
    expect(JSON.stringify(status.json())).not.toContain("completionCriteria");
    const list = await server.app.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(JSON.stringify(list.json())).not.toContain("completionCriteria");

    await server.app.inject({ method: "DELETE", url: `/api/agent-sessions/${sessionId}` });
    expect(await readdir(join(serviceConfig.stateDir, "sessions"))).toEqual([]);
    const refused = await sessions.plans.invoke(sessionId, "plans.get", {}, { turnId: "turn-x", isLive: () => true });
    expect(refused).toMatchObject({ ok: false, error: { code: "tools_unavailable" } });
    await server.app.close();
  });

  it("recovers a running plan from a restart before the next turn is accepted", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-plan-restart";
    const base = sessionDocument(sessionId, workspace, { runnerKind: "claude_code", running: true });
    await writeSessionDocument(serviceConfig, {
      ...base,
      schemaVersion: 2,
      plan: {
        id: "plan-restart", revision: 4, objective: "o", completionCriteria: "c",
        steps: [{ id: "step-1", description: "d", status: "in_progress", outcome: null, lastBlocker: null }],
        status: "running", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
        lastModifiedTurnId: `turn-${sessionId}`, executionTurnId: `turn-${sessionId}`, pauseReason: null, resumeNote: null, summary: null
      },
      planMutationReceipts: []
    });
    let sessions!: AgentSessionService;
    const server = await buildServer({ config: serviceConfig, runners: { claude_code: planningRunner(() => sessions) } });
    sessions = server.agentSessions;
    expect(await sessions.plans.prepareForTurn(sessionId)).toBe(true);
    await server.durableSessions.flush();
    expect((await sessionFile(serviceConfig.stateDir, sessionId)).plan).toMatchObject({
      revision: 5, status: "paused", pauseReason: "backend_restarted", executionTurnId: null, lastModifiedTurnId: `turn-${sessionId}`
    });
    expect((await sessions.plans.read(sessionId))).toMatchObject({ kind: "ok", plan: { steps: [{ status: "in_progress" }] } });
    await server.app.close();
  });
});
