import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { EventBus } from "../../events/EventBus";
import type { WorkspaceBranchChangedPayload } from "../../events/eventTypes";
import { publishWorkspaceBranchChanged } from "../../events/workspaceBranchChanged";
import type { LocalWorkspaceRegistry } from "../LocalWorkspaceRegistry";

/** The slice of `fs.FSWatcher` the watcher uses, so tests can drive events by hand. */
export interface HeadWatchHandle {
  close(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export type HeadWatchFunction = (
  directory: string,
  listener: (eventType: string, filename: string | null) => void
) => HeadWatchHandle;

export interface WorkspaceHeadWatcherDeps {
  registry: Pick<
    LocalWorkspaceRegistry,
    "listWithoutGitRefresh" | "gitCheckoutDir" | "gitCurrentBranch" | "refreshWorkspaceGit"
  >;
  eventBus: Pick<EventBus, "publish" | "subscribe">;
  /** Drops the workspace's cached file index, as the branch-switch route does. */
  invalidateFileIndex(workspaceId: string): void;
  watch?: HeadWatchFunction;
  /**
   * The git dir's device and inode, or undefined when it is gone. The reconcile
   * pass drops a watch whose git dir vanished or was replaced, as by a re-clone.
   */
  directoryIdentity?: (path: string) => Promise<string | undefined>;
  /** Reports a failure no caller waits on, such as an event subscriber throwing. */
  onError?: (error: unknown) => void;
  debounceMs?: number;
  minPublishIntervalMs?: number;
  reconcileIntervalMs?: number;
}

/** One checkout's HEAD, shared by every registered workspace inside it. */
interface HeadGroup {
  gitDir: string;
  /** `directoryIdentity` of the git dir when the watch opened. */
  identity: string;
  workspaces: Set<string>;
  handle: HeadWatchHandle;
  /** Last branch seen or announced; null is a detached HEAD, undefined is not read yet. */
  branch: string | null | undefined;
  timer?: NodeJS.Timeout;
  lastPublishAt: number;
  reading: boolean;
  recheck: boolean;
}

const defaultWatch: HeadWatchFunction = (directory, listener) =>
  watch(directory, { persistent: false }, (eventType, filename) => listener(eventType, filename));

async function defaultDirectoryIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
  } catch {
    return undefined;
  }
}

function workspaceIdOf(payload: unknown): string | undefined {
  const workspaceId = (payload as { workspaceId?: unknown } | undefined)?.workspaceId;
  return typeof workspaceId === "string" ? workspaceId : undefined;
}

/**
 * Publishes `workspace_branch_changed` with `origin: "observed"` when a
 * registered checkout's HEAD moves to another branch, whoever moved it.
 *
 * It watches each distinct git dir, not the HEAD file: Git replaces HEAD by
 * renaming `HEAD.lock` over it, which kills a file watch after one event. Only
 * events named exactly `HEAD` count. Every commit takes `HEAD.lock` without
 * rewriting HEAD, and the backend's own status reads churn `index`, so a
 * looser filter would fire constantly. A HEAD write does not mean the branch
 * changed (a no-op switch, a detached commit, a rebase that ends where it
 * began), so each burst ends in one `git branch --show-current` and publishes
 * only on a real change. Measured on macOS 2026-10-17 with Node 26 and
 * Git 2.54: a switch writes `HEAD.lock` then `HEAD`, a rebase's burst spans
 * about 40 ms, and deleting the git dir raises no `error` event.
 */
export class WorkspaceHeadWatcher {
  private readonly groups = new Map<string, HeadGroup>();
  private readonly groupOf = new Map<string, string>();
  /** Registered workspaces without a watch: not a repository yet, or their git dir vanished. */
  private readonly unwatched = new Set<string>();
  /** Workspaces that should be watched; an attach that finishes after a removal checks this. */
  private readonly registered = new Set<string>();
  private readonly watchDirectory: HeadWatchFunction;
  private readonly directoryIdentity: (path: string) => Promise<string | undefined>;
  private readonly debounceMs: number;
  private readonly minPublishIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  /** Reads still running; close waits for them so no Git command outlives shutdown. */
  private readonly inFlight = new Set<Promise<void>>();
  private unsubscribe?: () => void;
  private reconcileTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: WorkspaceHeadWatcherDeps) {
    this.watchDirectory = deps.watch ?? defaultWatch;
    this.directoryIdentity = deps.directoryIdentity ?? defaultDirectoryIdentity;
    this.debounceMs = deps.debounceMs ?? 300;
    this.minPublishIntervalMs = deps.minPublishIntervalMs ?? 1000;
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.deps.eventBus.subscribe((event) => {
      const workspaceId = workspaceIdOf(event.payload);
      if (!workspaceId) return;
      switch (event.type) {
        case "workspace_registered":
          this.track(this.attach(workspaceId));
          return;
        case "workspace_removed":
          this.detach(workspaceId);
          return;
        case "workspace_branch_changed": {
          const payload = event.payload as WorkspaceBranchChangedPayload;
          if (payload.origin === "observed") return;
          // AgentRoom moved the checkout itself and said so. Record the branch so
          // the HEAD write that switch caused doesn't publish it a second time.
          const group = this.groupFor(workspaceId);
          if (group) group.branch = payload.branch ?? null;
          return;
        }
      }
    });
    const workspaces = await this.deps.registry.listWithoutGitRefresh();
    await Promise.all(workspaces.map((workspace) => this.attach(workspace.id)));
    this.reconcileTimer = setInterval(() => this.track(this.reconcile()), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  /** Stops every watch and timer, then waits for reads already running. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const group of this.groups.values()) this.closeGroup(group);
    this.groups.clear();
    this.groupOf.clear();
    this.unwatched.clear();
    this.registered.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  /** Runs background work that no caller awaits, so its failure is reported, never unhandled. */
  private track(work: Promise<void>): void {
    const settled = work
      .catch((error: unknown) => this.deps.onError?.(error))
      .finally(() => this.inFlight.delete(settled));
    this.inFlight.add(settled);
  }

  /** Retries unwatched workspaces and drops watches whose git dir is gone or replaced. */
  async reconcile(): Promise<void> {
    if (this.closed) return;
    for (const group of [...this.groups.values()]) {
      const identity = await this.directoryIdentity(group.gitDir);
      if (identity !== group.identity && this.groups.get(group.gitDir) === group) this.dropGroup(group);
    }
    await Promise.all([...this.unwatched].map((workspaceId) => this.attach(workspaceId)));
  }

  private async attach(workspaceId: string): Promise<void> {
    if (this.closed || this.groupOf.has(workspaceId)) return;
    this.registered.add(workspaceId);
    this.unwatched.add(workspaceId);
    let gitDir: string | undefined;
    try {
      gitDir = await this.deps.registry.gitCheckoutDir(workspaceId);
    } catch {
      gitDir = undefined;
    }
    if (!gitDir || !this.stillWanted(workspaceId)) return;

    let group = this.groups.get(gitDir);
    if (!group) {
      const identity = await this.directoryIdentity(gitDir);
      if (!identity || !this.stillWanted(workspaceId)) return;
      // Another attach for the same checkout may have opened it meanwhile.
      group = this.groups.get(gitDir) ?? this.openGroup(gitDir, identity);
      if (!group) return;
    }
    group.workspaces.add(workspaceId);
    this.groupOf.set(workspaceId, gitDir);
    this.unwatched.delete(workspaceId);
    if (group.branch === undefined) await this.readBaseline(group, workspaceId);
  }

  private detach(workspaceId: string): void {
    this.registered.delete(workspaceId);
    this.unwatched.delete(workspaceId);
    const group = this.groupFor(workspaceId);
    this.groupOf.delete(workspaceId);
    if (!group) return;
    group.workspaces.delete(workspaceId);
    if (group.workspaces.size === 0) this.removeGroup(group);
  }

  /** Whether an attach that awaited is still wanted for this workspace. */
  private stillWanted(workspaceId: string): boolean {
    return !this.closed && this.registered.has(workspaceId) && !this.groupOf.has(workspaceId);
  }

  private openGroup(gitDir: string, identity: string): HeadGroup | undefined {
    const gitDirName = basename(gitDir);
    let group: HeadGroup | undefined;
    try {
      const handle = this.watchDirectory(gitDir, (_eventType, filename) => {
        if (!group || this.groups.get(gitDir) !== group) return;
        // Deleting the git dir raises no error. Its last event names the
        // directory itself, then the watch goes silent.
        if (filename === gitDirName) {
          this.dropGroup(group);
          return;
        }
        if (filename === null || filename === "HEAD") this.schedule(group);
      });
      group = {
        gitDir,
        identity,
        workspaces: new Set(),
        handle,
        branch: undefined,
        lastPublishAt: 0,
        reading: false,
        recheck: false
      };
      handle.on("error", () => {
        if (group && this.groups.get(gitDir) === group) this.dropGroup(group);
      });
    } catch {
      return undefined;
    }
    this.groups.set(gitDir, group);
    return group;
  }

  private async readBaseline(group: HeadGroup, workspaceId: string): Promise<void> {
    try {
      const branch = await this.deps.registry.gitCurrentBranch(workspaceId);
      if (group.branch === undefined) group.branch = branch ?? null;
    } catch {
      // Left unread; the next HEAD event records it without publishing.
    }
  }

  private schedule(group: HeadGroup): void {
    if (this.closed) return;
    if (group.timer) clearTimeout(group.timer);
    const sinceLastPublish = Date.now() - group.lastPublishAt;
    const delay = Math.max(this.debounceMs, this.minPublishIntervalMs - sinceLastPublish);
    group.timer = setTimeout(() => {
      group.timer = undefined;
      this.track(this.check(group));
    }, delay);
    group.timer.unref?.();
  }

  private async check(group: HeadGroup): Promise<void> {
    if (this.closed || this.groups.get(group.gitDir) !== group) return;
    if (group.reading) {
      group.recheck = true;
      return;
    }
    group.reading = true;
    try {
      await this.publishIfMoved(group);
    } finally {
      group.reading = false;
      if (group.recheck) {
        group.recheck = false;
        this.schedule(group);
      }
    }
  }

  private async publishIfMoved(group: HeadGroup): Promise<void> {
    const [reader] = group.workspaces;
    if (!reader) return;
    let branch: string | undefined;
    try {
      branch = await this.deps.registry.gitCurrentBranch(reader);
      // No branch is either a detached HEAD or no repository at all.
      if (branch === undefined && (await this.deps.registry.gitCheckoutDir(reader)) !== group.gitDir) {
        this.dropGroup(group);
        return;
      }
    } catch {
      return;
    }
    if (this.closed || this.groups.get(group.gitDir) !== group) return;
    const next = branch ?? null;
    const previous = group.branch;
    if (previous === next) return;
    group.branch = next;
    if (previous === undefined) return;
    group.lastPublishAt = Date.now();

    for (const workspaceId of [...group.workspaces]) {
      let path: string;
      try {
        // Past the snapshot cache, so a client's next read sees the new branch.
        path = (await this.deps.registry.refreshWorkspaceGit(workspaceId)).path;
      } catch {
        continue;
      }
      if (this.closed || this.groupFor(workspaceId) !== group) continue;
      this.deps.invalidateFileIndex(workspaceId);
      publishWorkspaceBranchChanged(this.deps.eventBus, {
        workspace: { id: workspaceId, path },
        ...(previous ? { previousBranch: previous } : {}),
        branch: next,
        origin: "observed"
      });
    }
  }

  /** Stops watching a git dir that is gone, keeping its workspaces queued for the reconcile pass. */
  private dropGroup(group: HeadGroup): void {
    this.removeGroup(group);
    for (const workspaceId of group.workspaces) {
      this.groupOf.delete(workspaceId);
      if (this.registered.has(workspaceId)) this.unwatched.add(workspaceId);
    }
  }

  private removeGroup(group: HeadGroup): void {
    this.closeGroup(group);
    this.groups.delete(group.gitDir);
  }

  private closeGroup(group: HeadGroup): void {
    if (group.timer) clearTimeout(group.timer);
    group.timer = undefined;
    try {
      group.handle.close();
    } catch {
      // Already closed.
    }
  }

  private groupFor(workspaceId: string): HeadGroup | undefined {
    const gitDir = this.groupOf.get(workspaceId);
    return gitDir ? this.groups.get(gitDir) : undefined;
  }
}
