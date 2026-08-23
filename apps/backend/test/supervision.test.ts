import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

// release-please rewrites backendVersion in src/releaseInfo.ts on every
// release, so pinning it here fails CI the moment a release lands. What a
// supervisor needs is that the field is present and is a version; the release
// workflow is what checks it against the tag and the two other annotated
// files. The minimumVersion fields carry no annotation and do not move with a
// release, so those stay pinned.
const expectedRelease = {
  backendVersion: expect.stringMatching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiVersion: "2026-05-12",
  minimumSupportedClientApiVersion: "2026-05-12",
  compatibleClients: {
    macos: { minimumVersion: "0.1.0" },
    visionos: { minimumVersion: "0.1.0" }
  }
};

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-supervision-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

describe("supervision endpoints", () => {
  it("exposes health and status fields sufficient for an app supervisor", async () => {
    const agentRoomHome = await mkdtemp(join(tmpdir(), "agentroom-home-"));
    const serviceConfig = await config({
      agentRoomHome,
      workspaceRoot: join(agentRoomHome, "workspaces"),
      stateDir: join(agentRoomHome, "state")
    });
    const { app } = await buildServer({ config: serviceConfig });

    const health = await app.inject({ method: "GET", url: "/health" });
    const status = await app.inject({ method: "GET", url: "/api/status" });
    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      runnerKind: "codex",
      mode: "agent-bridge",
      release: expectedRelease
    });
    expect(health.json().uptimeSeconds).toEqual(expect.any(Number));

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      runnerKind: "codex",
      sessions: [],
      activeSessionIds: [],
      metrics: {
        totalSessions: 0,
        runningSessions: 0,
        completedTurns: 0
      }
    });

    expect(publicConfig.statusCode).toBe(200);
    expect(publicConfig.json()).toMatchObject({
      agentRoomHome,
      workspaceRoot: join(agentRoomHome, "workspaces"),
      stateDir: join(agentRoomHome, "state"),
      requireAuth: false,
      release: expectedRelease
    });

    await app.close();
  });

  it("serves the bundled debug page even when started from another cwd", async () => {
    const previousCwd = process.cwd();
    const tempCwd = await mkdtemp(join(tmpdir(), "agentroom-cwd-"));
    process.chdir(tempCwd);
    try {
      const serviceConfig = await config();
      const { app } = await buildServer({ config: serviceConfig });

      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("AgentRoom");

      await app.close();
    } finally {
      process.chdir(previousCwd);
    }
  });
});
