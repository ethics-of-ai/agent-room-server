import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server";
import type { ServiceConfig, WorkspaceFilePreview } from "../src/domain/models";
import { SpatialSceneService } from "../src/scene/SpatialSceneService";
import { WorkspaceExplorerError } from "../src/workspace/WorkspaceExplorer";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-scene-"));
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

const baseSceneJson = JSON.stringify({
  schemaVersion: 1,
  name: "Test scene",
  entities: [
    {
      id: "crate-1",
      geometry: { kind: "box", size: [0.2, 0.2, 0.2] },
      transform: { position: [0, 0.1, 0] }
    }
  ]
});

const humanSceneJson = JSON.stringify({
  schemaVersion: 1,
  overrides: [{ id: "crate-1", transform: { position: [0.25, 0.1, -0.1] }, locked: true }]
});

async function registerWorkspace(app: Awaited<ReturnType<typeof buildServer>>["app"]): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "agentroom-scene-workspace-"));
  const response = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspaceDir } });
  expect(response.statusCode).toBe(201);
  return response.json().workspace.id as string;
}

describe("spatial scene GET route", () => {
  it("composes base and human layers and returns optimistic-lock tokens", async () => {
    const { app } = await buildServer({ config: await config() });
    const workspaceId = await registerWorkspace(app);
    const workspacePath = (await app.inject({ method: "GET", url: "/api/workspaces" })).json().workspaces[0]
      .path as string;
    await writeFile(join(workspacePath, "main.scene.json"), baseSceneJson);
    await writeFile(join(workspacePath, "main.scene.human.json"), humanSceneJson);

    const response = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`
    });
    expect(response.statusCode).toBe(200);
    const snapshot = response.json();
    expect(snapshot.version).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.document.entities[0]).toMatchObject({
      id: "crate-1",
      transform: { position: [0.25, 0.1, -0.1] },
      locked: true,
      humanEdited: true
    });
    expect(snapshot.base).toMatchObject({ path: "main.scene.json" });
    expect(snapshot.base.modifiedAt).toEqual(expect.any(String));
    expect(snapshot.human).toMatchObject({ path: "main.scene.human.json" });
    expect(snapshot.humanDocument.overrides).toHaveLength(1);
    await app.close();
  });

  it("rejects non-scene paths and invalid documents", async () => {
    const { app } = await buildServer({ config: await config() });
    const workspaceId = await registerWorkspace(app);
    const workspacePath = (await app.inject({ method: "GET", url: "/api/workspaces" })).json().workspaces[0]
      .path as string;

    const badPath = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=notes.md`
    });
    expect(badPath.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`
    });
    expect(missing.statusCode).toBe(404);

    await writeFile(join(workspacePath, "broken.scene.json"), "{not json");
    const invalidJson = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=broken.scene.json`
    });
    expect(invalidJson.statusCode).toBe(422);

    await writeFile(join(workspacePath, "wrong.scene.json"), JSON.stringify({ schemaVersion: 9, entities: [] }));
    const invalidSchema = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=wrong.scene.json`
    });
    expect(invalidSchema.statusCode).toBe(422);
    await app.close();
  });

  it("reflects an override written through the bounded PUT on the next read", async () => {
    const { app } = await buildServer({ config: await config() });
    const workspaceId = await registerWorkspace(app);
    const workspacePath = (await app.inject({ method: "GET", url: "/api/workspaces" })).json().workspaces[0]
      .path as string;
    await writeFile(join(workspacePath, "main.scene.json"), baseSceneJson);

    const before = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().human).toBeNull();
    expect(before.json().document.entities[0]).toMatchObject({ humanEdited: false });

    const written = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      payload: { path: "main.scene.human.json", content: humanSceneJson }
    });
    expect(written.statusCode).toBe(201);

    // Compose-on-read: no tracking or events — the next GET simply sees it.
    const after = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/spatial-scene?path=main.scene.json`
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().document.entities[0]).toMatchObject({
      transform: { position: [0.25, 0.1, -0.1] },
      locked: true,
      humanEdited: true
    });
    expect(after.json().version).not.toBe(before.json().version);
    await app.close();
  });
});

interface FakeFile {
  content: string;
  modifiedAt: string;
  truncated?: boolean;
}

function fakeExplorer(files: Map<string, FakeFile>) {
  return {
    async filePreview(workspaceId: string, input: { path: string; maxBytes?: number }): Promise<WorkspaceFilePreview> {
      const file = files.get(`${workspaceId}:${input.path}`);
      if (!file) {
        throw new WorkspaceExplorerError("Workspace path was not found", 404);
      }
      return {
        workspaceId,
        path: input.path,
        name: input.path,
        sizeBytes: Buffer.byteLength(file.content),
        modifiedAt: file.modifiedAt,
        encoding: "utf8",
        content: file.content,
        truncated: file.truncated ?? false,
        previewable: true
      };
    }
  };
}

describe("SpatialSceneService", () => {
  it("composes on read with no cached state between reads", async () => {
    const files = new Map<string, FakeFile>([["ws-1:main.scene.json", { content: baseSceneJson, modifiedAt: "t1" }]]);
    const service = new SpatialSceneService({ explorer: fakeExplorer(files) });

    const first = await service.getScene("ws-1", "main.scene.json");
    expect(first.document.entities[0]?.transform.position).toEqual([0, 0.1, 0]);
    expect(first.human).toBeNull();
    expect(first.humanDocument).toBeNull();

    const movedScene = JSON.stringify({
      schemaVersion: 1,
      entities: [
        { id: "crate-1", geometry: { kind: "box", size: [0.2, 0.2, 0.2] }, transform: { position: [1, 0.1, 0] } }
      ]
    });
    files.set("ws-1:main.scene.json", { content: movedScene, modifiedAt: "t2" });
    files.set("ws-1:main.scene.human.json", { content: humanSceneJson, modifiedAt: "t2" });

    const second = await service.getScene("ws-1", "main.scene.json");
    expect(second.document.entities[0]?.transform.position).toEqual([0.25, 0.1, -0.1]);
    expect(second.document.entities[0]?.humanEdited).toBe(true);
    expect(second.human).toMatchObject({ path: "main.scene.human.json", modifiedAt: "t2" });
    expect(second.version).not.toBe(first.version);
  });

  it("rejects base paths that are not scene files", async () => {
    const service = new SpatialSceneService({ explorer: fakeExplorer(new Map()) });
    await expect(service.getScene("ws-1", "notes.md")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.getScene("ws-1", "main.scene.human.json")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("maps oversize scene files to 413", async () => {
    const files = new Map<string, FakeFile>([
      ["ws-1:main.scene.json", { content: baseSceneJson, modifiedAt: "t1", truncated: true }]
    ]);
    const service = new SpatialSceneService({ explorer: fakeExplorer(files) });
    await expect(service.getScene("ws-1", "main.scene.json")).rejects.toMatchObject({ statusCode: 413 });
  });

  it("maps an invalid override file to 422 rather than composing without it", async () => {
    const files = new Map<string, FakeFile>([
      ["ws-1:main.scene.json", { content: baseSceneJson, modifiedAt: "t1" }],
      ["ws-1:main.scene.human.json", { content: "{not json", modifiedAt: "t1" }]
    ]);
    const service = new SpatialSceneService({ explorer: fakeExplorer(files) });
    await expect(service.getScene("ws-1", "main.scene.json")).rejects.toMatchObject({ statusCode: 422 });
  });
});
