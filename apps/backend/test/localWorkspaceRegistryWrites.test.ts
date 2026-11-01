import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalWorkspaceWorktree } from "../src/domain/childThreads";
import type { ServiceConfig } from "../src/domain/models";
import { registerWorkspacePayloadSchema } from "../src/domain/workspaceSchemas";
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

describe("managed worktree registration", () => {
  const worktreeFor = (path: string): LocalWorkspaceWorktree => ({
    parentWorkspaceId: "workspace-parent",
    worktreePath: path,
    branch: "agentroom/fix-abcdef12",
    baseCommit: "a".repeat(40)
  });

  it("keeps the kind and worktree record when a client re-registers the path", async () => {
    const serviceConfig = await config();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const path = await realpath(await mkdtemp(join(tmpdir(), "agentroom-registry-worktree-")));
    const worktree = worktreeFor(path);
    const { workspace: registered } = await registry.register({ path, worktree });
    expect(registered).toMatchObject({ kind: "managed_worktree", worktree });

    // What the public route passes for a client that names a kind, and for one that does not.
    const { workspace: renamed, created } = await registry.register({ path, name: "Renamed", kind: "user_selected" });
    await registry.register({ path });

    expect(created).toBe(false);
    expect(renamed).toMatchObject({ id: registered.id, name: "Renamed", kind: "managed_worktree", worktree });
    const reloaded = await new LocalWorkspaceRegistry(serviceConfig).findByIdWithoutGitRefresh(registered.id);
    expect(reloaded).toMatchObject({ kind: "managed_worktree", worktree });
  });

  it("refuses the kind without a worktree record, and the public payload refuses it outright", async () => {
    const registry = new LocalWorkspaceRegistry(await config());
    const path = await mkdtemp(join(tmpdir(), "agentroom-registry-worktree-"));

    await expect(registry.register({ path, kind: "managed_worktree" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(registry.listWithoutGitRefresh()).resolves.toEqual([]);
    expect(registerWorkspacePayloadSchema.safeParse({ path, kind: "managed_worktree" }).success).toBe(false);
    expect(registerWorkspacePayloadSchema.safeParse({ path, worktree: worktreeFor(path) }).data).toEqual({ path });
  });
});

describe("an unreadable registry file", () => {
  it("is moved aside instead of being overwritten by the next save", async () => {
    const serviceConfig = await config();
    await mkdir(serviceConfig.stateDir, { recursive: true });
    // A newer build's record kind this build does not know.
    const written = JSON.stringify({ workspaces: [{ id: "w1", kind: "future_kind" }] });
    await writeFile(join(serviceConfig.stateDir, "workspaces.json"), written);
    const registry = new LocalWorkspaceRegistry(serviceConfig);

    expect(await registry.listWithoutGitRefresh()).toEqual([]);
    const aside = (await readdir(serviceConfig.stateDir)).filter((name) => name.startsWith("workspaces.json.unreadable-"));
    expect(aside).toHaveLength(1);
    await expect(readFile(join(serviceConfig.stateDir, aside[0]!), "utf8")).resolves.toBe(written);
  });
});
