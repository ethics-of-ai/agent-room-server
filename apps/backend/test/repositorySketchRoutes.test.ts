import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { config, nativeSessionRunner, registerWorkspaceOffline } from "./support/agentSessionHarness";

const box = { op: "create", objectId: "box", kind: "box", size: [0.1, 0.1, 0.1] };

describe("repository sketch routes", () => {
  it("creates by name, edits by path, survives restart, and has no thread routes", async () => {
    const settings = await config();
    const workspace = await registerWorkspaceOffline(settings);
    const start = () => buildServer({ config: settings, runners: { claude_code: nativeSessionRunner("repository-sketch") } });
    let server = await start();
    try {
      expect((await server.app.inject({ method: "GET", url: "/api/config" })).json().repositorySketches).toBe(true);
      const base = `/api/workspaces/${workspace.id}/sketch`;
      expect((await server.app.inject({ method: "POST", url: base, payload: {} })).statusCode).toBe(400);
      const response = await server.app.inject({ method: "POST", url: base, payload: { name: "A sketch" } });
      expect(response.statusCode, response.body).toBe(201);
      const sketch = response.json().sketch;
      expect(sketch.path).toBe("a-sketch.sketch.json");
      const file = (action: string) => `${base}/${action}?path=${encodeURIComponent(sketch.path)}`;
      const payload = { requestId: "gesture", baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box] };
      const saved = await server.app.inject({ method: "POST", url: file("commits"), payload });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(JSON.parse(await readFile(join(workspace.path, sketch.path), "utf8")).revision).toBe(1);
      await server.app.close();
      server = await start();
      const reopened = await server.app.inject({ method: "GET", url: `${base}?path=${sketch.path}` });
      expect(reopened.json().sketch.revision).toBe(1);
      const replay = await server.app.inject({ method: "POST", url: file("commits"), payload });
      expect(replay.json()).toEqual(saved.json());
      const created = await server.app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, runnerKind: "claude_code" } });
      const threadRoute = `/api/agent-sessions/${created.json().session.id}/repository-sketch`;
      expect((await server.app.inject({ method: "GET", url: threadRoute })).statusCode).toBe(404);
      expect((await server.app.inject({ method: "POST", url: threadRoute })).statusCode).toBe(404);
    } finally { await server.app.close(); }
  });

  it("unregistration retains documents", async () => {
    const settings = await config();
    const workspace = await registerWorkspaceOffline(settings);
    const { app } = await buildServer({ config: settings, runners: { claude_code: nativeSessionRunner("unregister-sketch") } });
    try {
      const sketch = (await app.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sketch`, payload: { name: "Kept" } })).json().sketch;
      expect((await app.inject({ method: "DELETE", url: `/api/workspaces/${workspace.id}` })).statusCode).toBe(204);
      expect(JSON.parse(await readFile(join(workspace.path, sketch.path), "utf8")).sketchId).toBe(sketch.sketchId);
      expect((await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sketch?path=${sketch.path}` })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("authenticates every route and requires a file token before edits", async () => {
    const settings = await config({ requireAuth: true, authToken: "repository-token" });
    const workspace = await registerWorkspaceOffline(settings);
    const { app } = await buildServer({ config: settings, runners: { claude_code: nativeSessionRunner("auth-sketch") } });
    try {
      const headers = { authorization: "Bearer repository-token" };
      const base = `/api/workspaces/${workspace.id}/sketch`;
      const file = `${base}/commits?path=test.sketch.json`;
      for (const [method, url] of [["POST", base], ["GET", `${base}?path=test.sketch.json`],
        ["POST", file], ["POST", `${base}/undo?path=test.sketch.json`]] as const) {
        expect((await app.inject({ method, url })).statusCode).toBe(401);
      }
      const response = await app.inject({ method: "POST", url: base, headers, payload: { name: "Test" } });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().sketch.path).toBe("test.sketch.json");
      const noToken = await app.inject({ method: "POST", url: file, headers, payload: { requestId: "one", baseRevision: 0, operations: [box] } });
      expect(noToken.statusCode).toBe(400);
      const actor = await app.inject({ method: "POST", url: file, headers, payload: {
        requestId: "one", baseRevision: 0, fileVersion: response.json().sketch.fileVersion, operations: [box], actor: { kind: "agent" }
      } });
      expect(actor.statusCode).toBe(400);
      const generic = await app.inject({ method: "PUT", url: `/api/workspaces/${workspace.id}/file`, headers,
        payload: { path: "large.txt", content: "x".repeat(256 * 1024 + 1) } });
      expect(generic.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
