import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildServer } from "../src/server";
import { EventBus } from "../src/events/EventBus";
import type { AgentRoomEvent } from "../src/events/eventTypes";
import type { LocalWorkspace } from "../src/domain/models";
import { FileAuditLogStore } from "../src/state/FileAuditLogStore";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import {
  WorkspaceHeadWatcher,
  type WorkspaceHeadWatcherDeps
} from "../src/workspace/git/headWatcher";
import type { DirectoryWatchFunction } from "../src/workspace/watchSupport";
import { config, createGitWorkspace, git } from "./support/agentSessionHarness";

interface FakeCheckout {
  path: string;
  gitDir?: string;
  branch?: string;
}

interface FakeWatch {
  directory: string;
  listener: (eventType: string, filename: string | null) => void;
  error?: (error: unknown) => void;
  closed: boolean;
}

/** A registry and fs.watch the test drives by hand. */
function fakeHarness(checkouts: Record<string, FakeCheckout>) {
  const watches: FakeWatch[] = [];
  const reads: string[] = [];
  const invalidated: string[] = [];
  // Each git dir's device and inode; a re-clone gives the same path a new one.
  const identities = new Map<string, string>(
    Object.values(checkouts).flatMap((checkout) => (checkout.gitDir ? [[checkout.gitDir, "inode-1"] as const] : []))
  );
  const errors: unknown[] = [];
  const registry: WorkspaceHeadWatcherDeps["registry"] = {
    listWithoutGitRefresh: async () =>
      Object.entries(checkouts).map(([id, checkout]) => ({ id, path: checkout.path }) as LocalWorkspace),
    findByIdWithoutGitRefresh: async (id) =>
      checkouts[id] ? ({ id, path: checkouts[id].path } as LocalWorkspace) : undefined,
    gitCheckoutDir: async (id) => checkouts[id]?.gitDir,
    gitCurrentBranch: async (id) => {
      reads.push(id);
      return checkouts[id]?.branch;
    },
    refreshWorkspaceGit: async (id) => ({ id, path: checkouts[id].path }) as LocalWorkspace
  };
  const watch: DirectoryWatchFunction = (directory, listener) => {
    const entry: FakeWatch = { directory, listener, closed: false };
    watches.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
      on: (_event, listener) => {
        entry.error = listener;
      }
    };
  };
  const eventBus = new EventBus();
  const events: AgentRoomEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const watcher = new WorkspaceHeadWatcher({
    registry,
    eventBus,
    invalidateFileIndex: (id) => invalidated.push(id),
    watch,
    directoryIdentity: async (path) => identities.get(path),
    onError: (error) => errors.push(error),
    debounceMs: 5,
    minPublishIntervalMs: 0
  });
  const openWatch = (directory: string) => watches.find((entry) => entry.directory === directory && !entry.closed);
  const fire = (directory: string, filename: string | null = "HEAD") => {
    const entry = openWatch(directory);
    if (!entry) throw new Error(`no open watch on ${directory}`);
    entry.listener("rename", filename);
  };
  const observed = () =>
    events.filter((event) => event.type === "workspace_branch_changed" && (event.payload as { origin?: string }).origin === "observed");
  const filesChanged = () => events.filter((event) => event.type === "workspace_files_changed");
  return {
    checkouts,
    registry,
    watches,
    reads,
    invalidated,
    identities,
    errors,
    eventBus,
    events,
    watcher,
    openWatch,
    fire,
    observed,
    filesChanged
  };
}

const settle = () => sleep(40);

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await sleep(20);
  }
}

describe("WorkspaceHeadWatcher", () => {
  it("publishes one observed change per workspace that shares the checkout", async () => {
    const h = fakeHarness({
      root: { path: "/repo", gitDir: "/repo/.git", branch: "main" },
      nested: { path: "/repo/apps", gitDir: "/repo/.git", branch: "main" }
    });
    await h.watcher.start();
    expect(h.watches).toHaveLength(1);

    h.checkouts.root.branch = "feature/x";
    h.checkouts.nested.branch = "feature/x";
    h.fire("/repo/.git");
    await settle();

    expect(h.observed().map((event) => event.payload)).toEqual([
      { workspaceId: "root", path: "/repo", previousBranch: "main", branch: "feature/x", origin: "observed" },
      { workspaceId: "nested", path: "/repo/apps", previousBranch: "main", branch: "feature/x", origin: "observed" }
    ]);
    expect(h.invalidated).toEqual(["root", "nested"]);
    await h.watcher.close();
  });

  it("reads the branch only for a HEAD write", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    const baselineReads = h.reads.length;

    h.checkouts.repo.branch = "feature/x";
    for (const name of ["HEAD.lock", "index", "index.lock", "FETCH_HEAD", "ORIG_HEAD", "packed-refs.lock"]) {
      h.fire("/repo/.git", name);
    }
    await settle();

    expect(h.reads).toHaveLength(baselineReads);
    expect(h.observed()).toEqual([]);
    await h.watcher.close();
  });

  it("publishes one files change per workspace in the checkout for index and ref writes", async () => {
    const h = fakeHarness({
      root: { path: "/repo", gitDir: "/repo/.git", branch: "main" },
      nested: { path: "/repo/apps", gitDir: "/repo/.git", branch: "main" }
    });
    await h.watcher.start();

    // A `git add`, then a commit, as measured: index, then HEAD.lock.
    for (const name of ["index.lock", "index", "index", "HEAD.lock", "ORIG_HEAD"]) h.fire("/repo/.git", name);
    await settle();

    expect(h.filesChanged().map((event) => event.payload)).toEqual([
      { workspaceId: "root", workspacePath: "/repo" },
      { workspaceId: "nested", workspacePath: "/repo/apps" }
    ]);
    expect(h.eventBus.getRecentEvents().some((event) => event.type === "workspace_files_changed")).toBe(false);
    await h.watcher.close();
  });

  it("publishes no files change for lock files a status read takes, or for fetches", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    for (const name of ["index.lock", "FETCH_HEAD", "packed-refs.lock", "AUTO_MERGE.lock", "COMMIT_EDITMSG"]) {
      h.fire("/repo/.git", name);
    }
    await settle();

    expect(h.filesChanged()).toEqual([]);
    await h.watcher.close();
  });

  it("publishes nothing when HEAD was rewritten on the same branch", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    h.fire("/repo/.git");
    await settle();

    expect(h.observed()).toEqual([]);
    await h.watcher.close();
  });

  it("collapses a burst of HEAD writes into one read", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    const baselineReads = h.reads.length;

    h.checkouts.repo.branch = "feature/x";
    for (let index = 0; index < 8; index += 1) h.fire("/repo/.git");
    await settle();

    expect(h.reads.length - baselineReads).toBe(1);
    expect(h.observed()).toHaveLength(1);
    await h.watcher.close();
  });

  it("stays quiet for a switch AgentRoom already announced", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    h.checkouts.repo.branch = "feature/x";
    h.eventBus.publish("workspace_branch_changed", {
      workspaceId: "repo",
      path: "/repo",
      previousBranch: "main",
      branch: "feature/x"
    });
    h.fire("/repo/.git");
    await settle();

    expect(h.observed()).toEqual([]);
    await h.watcher.close();
  });

  it("reports a detached HEAD and the branch after it", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    h.checkouts.repo.branch = undefined;
    h.fire("/repo/.git");
    await settle();
    h.checkouts.repo.branch = "main";
    h.fire("/repo/.git");
    await settle();

    expect(h.observed().map((event) => event.payload)).toEqual([
      { workspaceId: "repo", path: "/repo", previousBranch: "main", detached: true, origin: "observed" },
      { workspaceId: "repo", path: "/repo", branch: "main", origin: "observed" }
    ]);
    await h.watcher.close();
  });

  it("drops a watch whose git dir was deleted and rewatches it once it is back", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    h.fire("/repo/.git", ".git");
    expect(h.openWatch("/repo/.git")).toBeUndefined();

    await h.watcher.reconcile();
    expect(h.watches.filter((entry) => !entry.closed)).toHaveLength(1);
    await h.watcher.close();
  });

  it("drops a watch whose git dir is gone when the reconcile pass finds it missing", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    h.identities.delete("/repo/.git");
    h.checkouts.repo.gitDir = undefined;

    await h.watcher.reconcile();

    expect(h.openWatch("/repo/.git")).toBeUndefined();
    await h.watcher.close();
  });

  it("rewatches a git dir the reconcile pass finds replaced, as by a re-clone", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    const original = h.openWatch("/repo/.git");
    h.identities.set("/repo/.git", "inode-2");

    await h.watcher.reconcile();

    expect(original?.closed).toBe(true);
    const replacement = h.openWatch("/repo/.git");
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(original);

    // The new watch reports a switch in the new clone.
    h.checkouts.repo.branch = "feature";
    h.fire("/repo/.git");
    await until(() => h.observed().length === 1);
    await h.watcher.close();
  });

  it("reports a subscriber that throws during publish instead of leaving it unhandled", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    h.eventBus.subscribe((event) => {
      if (event.type === "workspace_branch_changed") throw new Error("subscriber failed");
    });

    h.checkouts.repo.branch = "feature";
    h.fire("/repo/.git");
    await until(() => h.errors.length === 1);

    expect((h.errors[0] as Error).message).toBe("subscriber failed");
    await h.watcher.close();
  });

  it("reports a broken watch and publishes a files change once it is rewatched", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();

    h.openWatch("/repo/.git")?.error?.(new Error("EPERM"));

    expect(h.openWatch("/repo/.git")).toBeUndefined();
    expect(h.errors.map((error) => (error as Error).message)).toEqual(["EPERM"]);

    await h.watcher.reconcile();
    expect(h.openWatch("/repo/.git")).toBeDefined();
    await settle();
    expect(h.filesChanged()).toHaveLength(1);
    await h.watcher.close();
  });

  it("watches a workspace registered later and closes the watch when the last one is removed", async () => {
    const h = fakeHarness({ plain: { path: "/plain" } });
    await h.watcher.start();
    expect(h.watches).toHaveLength(0);

    h.checkouts.repo = { path: "/repo", gitDir: "/repo/.git", branch: "main" };
    h.identities.set("/repo/.git", "inode-1");
    h.eventBus.publish("workspace_registered", { workspaceId: "repo", path: "/repo" });
    await until(() => h.openWatch("/repo/.git") !== undefined);

    h.eventBus.publish("workspace_removed", { workspaceId: "repo", path: "/repo" });
    expect(h.openWatch("/repo/.git")).toBeUndefined();
    await h.watcher.close();
  });

  it("waits for a read already running before close resolves", async () => {
    const h = fakeHarness({ repo: { path: "/repo", gitDir: "/repo/.git", branch: "main" } });
    await h.watcher.start();
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reading = false;
    const branchRead = h.registry.gitCurrentBranch;
    h.registry.gitCurrentBranch = async (id: string) => {
      reading = true;
      await readHeld;
      return branchRead(id);
    };

    h.checkouts.repo.branch = "feature/x";
    h.fire("/repo/.git");
    await until(() => reading);
    let closed = false;
    const closing = h.watcher.close().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);

    releaseRead();
    await closing;
    expect(closed).toBe(true);
    expect(h.observed()).toEqual([]);
  });

  it("closes every watch on close", async () => {
    const h = fakeHarness({
      one: { path: "/one", gitDir: "/one/.git", branch: "main" },
      two: { path: "/two", gitDir: "/two/.git", branch: "main" }
    });
    await h.watcher.start();

    await h.watcher.close();

    expect(h.watches.every((entry) => entry.closed)).toBe(true);
  });
});

describe("observed branch changes", () => {
  it("stay out of the durable audit log", async () => {
    const store = new FileAuditLogStore(await config());
    const eventBus = new EventBus();
    store.attach(eventBus);

    eventBus.publish("workspace_branch_changed", { workspaceId: "w", path: "/w", branch: "b", origin: "observed" });
    eventBus.publish("workspace_branch_changed", { workspaceId: "w", path: "/w", branch: "c" });
    await store.flush();

    expect(store.getRecent().map((entry) => entry.type)).toEqual(["workspace_branch_changed"]);
  });
});

describe("WorkspaceHeadWatcher on a real repository", () => {
  async function realHarness() {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    await git(workspacePath, "branch", "feature/real");
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const { workspace } = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const events: AgentRoomEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const watcher = new WorkspaceHeadWatcher({ registry, eventBus, invalidateFileIndex: () => {} });
    await watcher.start();
    const observed = () => events.filter((event) => event.type === "workspace_branch_changed");
    const filesChanged = () => events.filter((event) => event.type === "workspace_files_changed");
    return { workspacePath, workspace, registry, watcher, observed, filesChanged };
  }

  it("publishes a git switch made outside AgentRoom", async () => {
    const h = await realHarness();
    try {
      await git(h.workspacePath, "switch", "feature/real");
      await until(() => h.observed().length > 0);

      expect(h.observed()[0].payload).toEqual({
        workspaceId: h.workspace.id,
        path: h.workspace.path,
        previousBranch: "main",
        branch: "feature/real",
        origin: "observed"
      });
      // The snapshot cache was bypassed, so a client's next read sees the new branch.
      await expect(h.registry.findById(h.workspace.id)).resolves.toMatchObject({ git: { branch: "feature/real" } });
    } finally {
      await h.watcher.close();
    }
  });

  it("publishes nothing for a commit on the current branch", async () => {
    const h = await realHarness();
    try {
      await git(h.workspacePath, "commit", "--allow-empty", "-m", "Empty");
      await git(h.workspacePath, "status", "--porcelain");
      await sleep(700);

      expect(h.observed()).toEqual([]);
    } finally {
      await h.watcher.close();
    }
  });

  it("publishes a files change for a git add outside AgentRoom, and none for its own status reads", async () => {
    const h = await realHarness();
    try {
      await writeFile(join(h.workspacePath, "staged.txt"), "staged\n");
      // AgentRoom's reads run with GIT_OPTIONAL_LOCKS=0 and write nothing.
      await h.registry.refreshWorkspaceGit(h.workspace.id);
      await sleep(700);
      expect(h.filesChanged()).toEqual([]);

      await git(h.workspacePath, "add", "staged.txt");
      await until(() => h.filesChanged().length > 0);
      expect(h.filesChanged()[0].payload).toEqual({ workspaceId: h.workspace.id, workspacePath: h.workspace.path });
    } finally {
      await h.watcher.close();
    }
  });

  it("watches a linked worktree's own HEAD", async () => {
    const h = await realHarness();
    const worktreePath = join(h.workspacePath, "..", `${h.workspace.id}-worktree`);
    await git(h.workspacePath, "worktree", "add", worktreePath, "-b", "feature/worktree");
    const linked = (await h.registry.register({ path: worktreePath })).workspace;
    // Registered after the first watcher started and without the route's
    // event, so a second watcher picks it up at its own start.
    const events: AgentRoomEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => events.push(event));
    const linkedWatcher = new WorkspaceHeadWatcher({ registry: h.registry, eventBus, invalidateFileIndex: () => {} });
    try {
      await linkedWatcher.start();
      await git(worktreePath, "switch", "feature/real");
      await until(() => events.some((event) => event.type === "workspace_branch_changed"));

      const changed = events.filter((event) => event.type === "workspace_branch_changed").map((event) => event.payload);
      expect(changed).toEqual([
        { workspaceId: linked.id, path: linked.path, previousBranch: "feature/worktree", branch: "feature/real", origin: "observed" }
      ]);
    } finally {
      await linkedWatcher.close();
      await h.watcher.close();
    }
  });
});

describe("WorkspaceHeadWatcher behind the branch route", () => {
  it("announces a route switch once and still reports the next switch made outside AgentRoom", async () => {
    const workspacePath = await createGitWorkspace();
    await git(workspacePath, "branch", "feature/route");
    const { app, eventBus } = await buildServer({ config: await config() });
    try {
      const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspacePath } });
      const workspace = registered.json().workspace as LocalWorkspace;
      const branchChanges = () =>
        eventBus.getRecentEvents().filter((event) => event.type === "workspace_branch_changed").map((event) => event.payload);

      const switched = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/git/branch`,
        payload: { branch: "feature/route" }
      });
      expect(switched.statusCode).toBe(200);
      // A terminal switch right after: the watcher must report this one, and
      // only this one, so the route's own HEAD write published nothing.
      await git(workspacePath, "switch", "main");
      await until(() => branchChanges().length >= 2);
      await settle();

      expect(branchChanges()).toEqual([
        { workspaceId: workspace.id, path: workspace.path, previousBranch: "main", branch: "feature/route" },
        { workspaceId: workspace.id, path: workspace.path, previousBranch: "feature/route", branch: "main", origin: "observed" }
      ]);
    } finally {
      await app.close();
    }
  });
});
