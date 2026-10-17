import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../src/domain/models";
import { defaultGitExecutor, type GitCommandExecutor } from "../src/workspace/git/execution";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";

const config = async (): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-registry-writes-"));
  return {
    runnerKind: "codex",
    host: "127.0.0.1",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: []
  };
};

/** Git that holds every command run in `heldPath` until `release` is called. */
function gatedGit(): { runGit: GitCommandExecutor; hold(path: string): void; release(): void; held: Promise<void> } {
  const realGit = defaultGitExecutor(30_000);
  let heldPath: string | undefined;
  let release!: () => void;
  let gate = Promise.resolve();
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  return {
    runGit: async (cwd, args, env) => {
      if (cwd === heldPath) {
        signalHeld();
        await gate;
      }
      return realGit(cwd, args, env);
    },
    hold(path) {
      heldPath = path;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
    held
  };
}

async function storedIds(serviceConfig: ServiceConfig): Promise<string[]> {
  const stored = JSON.parse(await readFile(join(serviceConfig.stateDir, "workspaces.json"), "utf8"));
  return stored.workspaces.map((workspace: { id: string }) => workspace.id).sort();
}

describe("registry writes during a slow git refresh", () => {
  it("keeps a workspace removed while another workspace's refresh waits on git", async () => {
    const serviceConfig = await config();
    const gitGate = gatedGit();
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: gitGate.runGit });
    const slowPath = await realpath(await mkdtemp(join(tmpdir(), "agentroom-registry-slow-")));
    const { workspace: slow } = await registry.register({ path: slowPath });
    const { workspace: removed } = await registry.register({
      path: await mkdtemp(join(tmpdir(), "agentroom-registry-removed-"))
    });

    gitGate.hold(slowPath);
    const refresh = registry.refreshWorkspaceGit(slow.id);
    await gitGate.held;
    await registry.unregister(removed.id);
    gitGate.release();
    await refresh;

    const listed = await registry.listWithoutGitRefresh();
    expect(listed.map((workspace) => workspace.id)).toEqual([slow.id]);
    await expect(storedIds(serviceConfig)).resolves.toEqual([slow.id]);
  });

  it("keeps a workspace registered while another workspace's refresh waits on git", async () => {
    const serviceConfig = await config();
    const gitGate = gatedGit();
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: gitGate.runGit });
    const slowPath = await realpath(await mkdtemp(join(tmpdir(), "agentroom-registry-slow-")));
    const { workspace: slow } = await registry.register({ path: slowPath });

    gitGate.hold(slowPath);
    const refresh = registry.refreshWorkspaceGit(slow.id);
    await gitGate.held;
    const { workspace: added } = await registry.register({
      path: await mkdtemp(join(tmpdir(), "agentroom-registry-added-"))
    });
    gitGate.release();
    await refresh;

    const listed = await registry.listWithoutGitRefresh();
    expect(listed.map((workspace) => workspace.id).sort()).toEqual([slow.id, added.id].sort());
    await expect(storedIds(serviceConfig)).resolves.toEqual([slow.id, added.id].sort());
  });

  it("does not bring back a workspace removed while its own refresh waits on git", async () => {
    const serviceConfig = await config();
    const gitGate = gatedGit();
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: gitGate.runGit });
    const slowPath = await realpath(await mkdtemp(join(tmpdir(), "agentroom-registry-slow-")));
    const { workspace: slow } = await registry.register({ path: slowPath });

    gitGate.hold(slowPath);
    const refresh = registry.refreshWorkspaceGit(slow.id);
    await gitGate.held;
    await registry.unregister(slow.id);
    gitGate.release();

    await expect(refresh).rejects.toMatchObject({ statusCode: 404 });
    await expect(registry.listWithoutGitRefresh()).resolves.toEqual([]);
    await expect(storedIds(serviceConfig)).resolves.toEqual([]);
  });
});
