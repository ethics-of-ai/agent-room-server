import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EventBus } from "../src/events/EventBus";
import type { AgentRoomEvent } from "../src/events/eventTypes";
import type { LocalWorkspace } from "../src/domain/models";
import { FileAuditLogStore } from "../src/state/FileAuditLogStore";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import {
  isVisibleChange,
  WorkspaceTreeWatcher,
  type WorkspaceTreeWatcherDeps
} from "../src/workspace/explorer/treeWatcher";
import type { DirectoryWatchFunction } from "../src/workspace/watchSupport";
import { config, createGitWorkspace, git } from "./support/agentSessionHarness";

interface FakeWatch {
  directory: string;
  listener: (eventType: string, filename: string | null) => void;
  error?: (error: unknown) => void;
  closed: boolean;
}

/** A registry and fs.watch the test drives by hand. */
function fakeHarness(
  workspaces: Record<string, string>,
  options: { minPublishIntervalMs?: number; maxWaitMs?: number } = {}
) {
  const watches: FakeWatch[] = [];
  // When set, opening a watch throws this, as fs.watch does on EMFILE.
  let openFailure: Error | undefined;
  const invalidated: string[] = [];
  const identities = new Map<string, string>(Object.values(workspaces).map((path) => [path, "inode-1"]));
  const errors: unknown[] = [];
  const registry: WorkspaceTreeWatcherDeps["registry"] = {
    listWithoutGitRefresh: async () =>
      Object.entries(workspaces).map(([id, path]) => ({ id, path }) as LocalWorkspace),
    findByIdWithoutGitRefresh: async (id) => (workspaces[id] ? ({ id, path: workspaces[id] } as LocalWorkspace) : undefined)
  };
  const watch: DirectoryWatchFunction = (directory, listener) => {
    if (openFailure) throw openFailure;
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
  const watcher = new WorkspaceTreeWatcher({
    registry,
    eventBus,
    invalidateFileIndex: (id) => invalidated.push(id),
    watch,
    directoryIdentity: async (path) => identities.get(path),
    onError: (error) => errors.push(error),
    debounceMs: 5,
    minPublishIntervalMs: options.minPublishIntervalMs ?? 0,
    maxWaitMs: options.maxWaitMs ?? 1000
  });
  const openWatch = (directory: string) => watches.find((entry) => entry.directory === directory && !entry.closed);
  const fire = (directory: string, filename: string | null, eventType = "change") => {
    const entry = openWatch(directory);
    if (!entry) throw new Error(`no open watch on ${directory}`);
    entry.listener(eventType, filename);
  };
  const changed = () => events.filter((event) => event.type === "workspace_files_changed");
  const failOpens = (error: Error | undefined) => {
    openFailure = error;
  };
  return { workspaces, watches, invalidated, identities, errors, eventBus, events, watcher, openWatch, fire, changed, failOpens };
}

const settle = () => sleep(40);

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await sleep(20);
  }
}

describe("isVisibleChange", () => {
  it("counts paths the tree read lists and skips every hidden segment", () => {
    expect(isVisibleChange("README.md")).toBe(true);
    expect(isVisibleChange("src/app/main.ts")).toBe(true);
    expect(isVisibleChange("")).toBe(true);
    for (const hidden of [
      ".git/index",
      ".git",
      "apps/web/node_modules/react/index.js",
      "build/out.o",
      "apps/macos/DerivedData/x",
      ".env",
      "config/.env.local",
      "certs/server.pem",
      "notes.md.agentroom-tmp",
      ".DS_Store"
    ]) {
      expect(isVisibleChange(hidden), hidden).toBe(false);
    }
  });
});

describe("WorkspaceTreeWatcher", () => {
  it("publishes one path-free change per burst, live and outside the replay buffer", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();
    expect(h.watches.map((entry) => entry.directory)).toEqual(["/repo"]);

    h.fire("/repo", "src/a.ts");
    h.fire("/repo", "src/b.ts");
    h.fire("/repo", "README.md");
    await settle();

    expect(h.changed().map((event) => event.payload)).toEqual([{ workspaceId: "repo", workspacePath: "/repo" }]);
    expect(h.eventBus.getRecentEvents()).toEqual([]);
    await h.watcher.close();
  });

  it("ignores changes under hidden paths, such as the backend's own Git reads", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();

    for (const name of [".git/index", ".git/index.lock", "node_modules/x/y.js", "build/a", ".env", "a.md.agentroom-tmp"]) {
      h.fire("/repo", name, "rename");
    }
    await settle();

    expect(h.changed()).toEqual([]);
    expect(h.invalidated).toEqual([]);
    await h.watcher.close();
  });

  it("counts an unattributed change", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();
    h.fire("/repo", null);
    await settle();
    expect(h.changed()).toHaveLength(1);
    await h.watcher.close();
  });

  it("invalidates the file index only when an entry appeared, vanished, or moved", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();

    h.fire("/repo", "src/a.ts", "change");
    await settle();
    expect(h.invalidated).toEqual([]);

    h.fire("/repo", "src/new.ts", "rename");
    await settle();
    expect(h.invalidated).toEqual(["repo"]);
    expect(h.changed()).toHaveLength(2);
    await h.watcher.close();
  });

  it("holds a second burst until the minimum interval has passed", async () => {
    const h = fakeHarness({ repo: "/repo" }, { minPublishIntervalMs: 200 });
    await h.watcher.start();

    h.fire("/repo", "a.ts");
    await settle();
    expect(h.changed()).toHaveLength(1);
    h.fire("/repo", "b.ts");
    await settle();
    expect(h.changed()).toHaveLength(1);
    await until(() => h.changed().length === 2);
    await h.watcher.close();
  });

  it("still publishes during a steady stream that never goes quiet", async () => {
    const h = fakeHarness({ repo: "/repo" }, { maxWaitMs: 50 });
    await h.watcher.start();

    // A change every 2 ms never leaves the 5 ms of quiet a burst waits for.
    const stream = setInterval(() => h.fire("/repo", "logs/dev.log"), 2);
    try {
      await until(() => h.changed().length >= 2, 1000);
    } finally {
      clearInterval(stream);
    }
    await h.watcher.close();
  });

  it("watches a workspace registered later and closes its watch when it is removed", async () => {
    const h = fakeHarness({ repo: "/repo", later: "/later" });
    h.identities.delete("/later");
    await h.watcher.start();
    expect(h.openWatch("/later")).toBeUndefined();

    h.identities.set("/later", "inode-1");
    h.eventBus.publish("workspace_registered", { workspaceId: "later", path: "/later" });
    await settle();
    expect(h.openWatch("/later")).toBeDefined();

    h.eventBus.publish("workspace_removed", { workspaceId: "later", path: "/later" });
    expect(h.openWatch("/later")).toBeUndefined();
    expect(h.openWatch("/repo")).toBeDefined();
    await h.watcher.close();
  });

  it("reports a broken watch, rewatches the root, and publishes what the gap may have missed", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();
    h.openWatch("/repo")?.error?.(new Error("EMFILE"));
    expect(h.openWatch("/repo")).toBeUndefined();
    expect(h.errors.map((error) => (error as Error).message)).toEqual(["EMFILE"]);

    await h.watcher.reconcile();
    expect(h.openWatch("/repo")).toBeDefined();
    await settle();
    expect(h.changed()).toHaveLength(1);
    expect(h.invalidated).toEqual(["repo"]);
    await h.watcher.close();
  });

  it("reports a watch that will not open once per failure, not on every retry", async () => {
    const h = fakeHarness({ repo: "/repo" });
    h.failOpens(new Error("ENOSPC"));
    await h.watcher.start();
    await h.watcher.reconcile();
    await h.watcher.reconcile();
    expect(h.errors.map((error) => (error as Error).message)).toEqual(["ENOSPC"]);

    h.failOpens(undefined);
    await h.watcher.reconcile();
    expect(h.openWatch("/repo")).toBeDefined();
    h.openWatch("/repo")?.error?.(new Error("EMFILE"));
    expect(h.errors).toHaveLength(2);
    await h.watcher.close();
  });

  it("rewatches a root the reconcile pass finds replaced, and drops one that is gone", async () => {
    const h = fakeHarness({ repo: "/repo", gone: "/gone" });
    await h.watcher.start();
    const original = h.openWatch("/repo");

    h.identities.set("/repo", "inode-2");
    h.identities.delete("/gone");
    await h.watcher.reconcile();

    expect(original?.closed).toBe(true);
    expect(h.openWatch("/repo")).toBeDefined();
    expect(h.openWatch("/repo")).not.toBe(original);
    expect(h.openWatch("/gone")).toBeUndefined();
    await h.watcher.close();
  });

  it("reports a subscriber that throws during publish instead of leaving it unhandled", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();
    h.eventBus.subscribe((event) => {
      if (event.type === "workspace_files_changed") throw new Error("subscriber failed");
    });
    h.fire("/repo", "a.ts");
    await settle();
    expect(h.errors).toHaveLength(1);
    await h.watcher.close();
  });

  it("publishes nothing after close", async () => {
    const h = fakeHarness({ repo: "/repo" });
    await h.watcher.start();
    const entry = h.openWatch("/repo");
    await h.watcher.close();
    expect(entry?.closed).toBe(true);
    entry?.listener("change", "a.ts");
    await settle();
    expect(h.changed()).toEqual([]);
  });
});

describe("observed file changes", () => {
  it("stay out of the durable audit log", async () => {
    const store = new FileAuditLogStore(await config());
    const eventBus = new EventBus();
    store.attach(eventBus);

    eventBus.publishLive("workspace_files_changed", { workspaceId: "w", workspacePath: "/w" });
    eventBus.publish("workspace_file_deleted", { workspaceId: "w", workspacePath: "/w", path: "a.md" });
    await store.flush();

    expect(store.getRecent().map((entry) => entry.type)).toEqual(["workspace_file_deleted"]);
  });
});

describe("WorkspaceTreeWatcher on a real workspace", () => {
  async function realHarness() {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const { workspace } = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const events: AgentRoomEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const invalidated: string[] = [];
    const watcher = new WorkspaceTreeWatcher({ registry, eventBus, invalidateFileIndex: (id) => invalidated.push(id) });
    await watcher.start();
    // FSEvents can deliver a late notification for the setup writes.
    await sleep(400);
    events.length = 0;
    invalidated.length = 0;
    const changed = () => events.filter((event) => event.type === "workspace_files_changed");
    return { workspacePath, workspace, watcher, changed, invalidated };
  }

  it("publishes a file created outside AgentRoom", async () => {
    const h = await realHarness();
    try {
      await mkdir(join(h.workspacePath, "src"));
      await writeFile(join(h.workspacePath, "src", "made-in-terminal.ts"), "export {};\n");
      await until(() => h.changed().length > 0);

      expect(h.changed()[0].payload).toEqual({ workspaceId: h.workspace.id, workspacePath: h.workspace.path });
      expect(h.invalidated).toContain(h.workspace.id);
    } finally {
      await h.watcher.close();
    }
  });

  it("publishes nothing for Git reads or ignored folders", async () => {
    const h = await realHarness();
    try {
      await git(h.workspacePath, "status", "--porcelain");
      await mkdir(join(h.workspacePath, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(h.workspacePath, "node_modules", "pkg", "index.js"), "\n");
      await sleep(800);
      expect(h.changed()).toEqual([]);
    } finally {
      await h.watcher.close();
    }
  });
});
