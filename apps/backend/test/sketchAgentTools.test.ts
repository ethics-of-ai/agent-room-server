import { describe, expect, it, vi } from "vitest";
import { allAgentTools } from "../src/agentTools/catalog";
import { agentSessionMessageContextSchema, agentTurnContextSchema } from "../src/domain/schemas";
import { buildServer } from "../src/server";
import { config, nativeSessionRunner, registerWorkspaceOffline, waitForSession } from "./support/agentSessionHarness";

const selection = { sketchId: "sketch-legacy", revision: 0, objectIds: ["box-1"] };

describe("human sketches are independent of agent turns", () => {
  it("rejects new sketch context while keeping historical message context readable", () => {
    expect(agentTurnContextSchema.safeParse({ sketch: selection }).success).toBe(false);
    expect(agentSessionMessageContextSchema.parse({ sketch: selection })).toEqual({ sketch: selection });
    expect(allAgentTools().filter((tool) => tool.logicalId.startsWith("sketch."))).toEqual([]);
  });

  it("creates, edits, undoes, and redoes without invoking an agent process", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const runner = nativeSessionRunner("must-not-start");
    const run = vi.spyOn(runner, "run").mockImplementation(() => {
      throw new Error("No agent process is available");
    });
    const { app } = await buildServer({ config: serviceConfig, runners: { claude_code: runner } });
    try {
      const created = await app.inject({ method: "POST", url: "/api/agent-sessions",
        payload: { workspaceId: workspace.id, runnerKind: "claude_code" } });
      const sessionId = created.json().session.id;
      const sketch = await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sketch`, payload: { name: "Human" } });
      expect(sketch.statusCode).toBe(201);
      const base = `/api/workspaces/${workspace.id}/sketch`;
      const query = `?path=${encodeURIComponent(sketch.json().sketch.path)}`;
      const edit = await app.inject({ method: "POST", url: `${base}/commits${query}`, payload: {
        requestId: "human-only-edit", baseRevision: 0, fileVersion: sketch.json().sketch.fileVersion,
        operations: [{ op: "create", objectId: "box-1", kind: "box", size: [0.1, 0.1, 0.1] }]
      } });
      expect(edit.statusCode).toBe(200);
      expect(edit.json().receipt.actor).toEqual({ kind: "human" });
      const undo = await app.inject({ method: "POST", url: `${base}/undo${query}`,
        payload: { requestId: "human-only-undo", baseRevision: 1, fileVersion: edit.json().fileVersion } });
      expect(undo.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: base + query })).json().sketch.document.objects).toEqual([]);
      expect((await app.inject({ method: "POST", url: `${base}/redo${query}`,
        payload: { requestId: "human-only-redo", baseRevision: 2, fileVersion: undo.json().fileVersion } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: base + query })).json().sketch.document.objects)
        .toEqual([expect.objectContaining({ id: "box-1" })]);
      expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` })).json().session)
        .toMatchObject({ status: "idle", turnCount: 0 });
      expect(run).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("refuses retired turn context without starting a turn", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const runner = nativeSessionRunner("human-sketch");
    const { app, agentSessions } = await buildServer({ config: serviceConfig, runners: { claude_code: runner } });
    try {
      const created = await app.inject({ method: "POST", url: "/api/agent-sessions",
        payload: { workspaceId: workspace.id, runnerKind: "claude_code" } });
      const sessionId = created.json().session.id;
      const url = `/api/agent-sessions/${sessionId}/turns`;
      const rejected = await app.inject({ method: "POST", url,
        payload: { message: "Change my sketch", context: { sketch: selection } } });
      expect(rejected.statusCode).toBe(400);
      await expect(agentSessions.startTurn({ sessionId, message: "Change my sketch",
        context: { sketch: selection } })).rejects.toMatchObject({ statusCode: 400 });
      const unchanged = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
      expect(unchanged.json().session).toMatchObject({ status: "idle", turnCount: 0 });
      const ordinary = await app.inject({ method: "POST", url, payload: { message: "Hello" } });
      expect(ordinary.statusCode).toBe(202);
      await waitForSession(app, sessionId, "idle");
    } finally { await app.close(); }
  });
});
