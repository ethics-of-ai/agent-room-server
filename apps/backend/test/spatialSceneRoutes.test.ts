import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-scene-routes-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    editorCatalogDir: join(root, ".catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

describe("spatial scene route auth and gating", () => {
  it("requires the bearer token for scene reads when AUTH_TOKEN is configured", async () => {
    const { app } = await buildServer({ config: await config({ requireAuth: true, authToken: "secret-token" }) });
    const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-scene-auth-workspace-"));
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: workspaceDir },
      headers: { authorization: "Bearer secret-token" }
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.id as string;

    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`,
      headers: { authorization: "Bearer secret-token" }
    });
    // Authorized but the scene file does not exist yet.
    expect(authorized.statusCode).toBe(404);
    await app.close();
  });

  it("does not register the route when the scene engine is disabled", async () => {
    const { app } = await buildServer({ config: await config({ sceneEngineEnabled: false }) });
    const response = await app.inject({
      method: "GET",
      url: "/api/workspaces/workspace-000000000000/spatial-scene?path=main.scene.json"
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("exposes the scene engine flag in public config", async () => {
    const enabled = await buildServer({ config: await config() });
    const enabledConfig = await enabled.app.inject({ method: "GET", url: "/api/config" });
    expect(enabledConfig.json().sceneEngineEnabled).toBe(true);
    await enabled.app.close();

    const disabled = await buildServer({ config: await config({ sceneEngineEnabled: false }) });
    const disabledConfig = await disabled.app.inject({ method: "GET", url: "/api/config" });
    expect(disabledConfig.json().sceneEngineEnabled).toBe(false);
    await disabled.app.close();
  });
});
