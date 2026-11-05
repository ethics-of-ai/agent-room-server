import { watch } from "node:fs";
import { basename } from "node:path";
import type { EventBus } from "../../events/EventBus";
import type { WorkspaceBranchChangedPayload } from "../../events/eventTypes";
import { publishWorkspaceBranchChanged } from "../../events/workspaceBranchChanged";
import { publishWorkspaceFilesChanged } from "../../events/workspaceFilesChanged";
import type { LocalWorkspaceRegistry } from "../LocalWorkspaceRegistry";
import {
  BackgroundWork,
  BurstSchedule,
  directoryIdentity,
  WatchFailureReporter,
  workspaceIdOf,
  type DirectoryWatchFunction,
  type DirectoryWatchHandle
} from "../watchSupport";

export interface WorkspaceHeadWatcherDeps {
  registry: Pick<
    LocalWorkspaceRegistry,
    | "listWithoutGitRefresh"
    | "findByIdWithoutGitRefresh"
    | "gitCheckoutDir"
    | "gitCurrentBranch"
    | "refreshWorkspaceGit"
  >;
  eventBus: Pick<EventBus, "publish" | "publishLive" | "subscribe">;
  /** Drops the workspace's cached file index, as the branch-switch route does. */
  invalidateFileIndex(workspaceId: string): void;
  watch?: DirectoryWatchFunction;
  /**
   * The git dir's device and inode, or undefined when it is gone. The reconcile
   * pass drops a watch whose git dir vanished or was replaced, as by a re-clone.
   */
  directoryIdentity?: (path: string) => Promise<string | undefined>;
  /** Reports a failure no caller waits on: a watch that would not open or broke, or a subscriber throwing. */
  onError?: (error: unknown) => void;
  debounceMs?: number;
  minPublishIntervalMs?: number;
  maxWaitMs?: number;
  reconcileIntervalMs?: number;
}

/** One checkout's HEAD, shared by every registered workspace inside it. */
interface HeadGroup {
  gitDir: string;
  /** `directoryIdentity` of the git dir when the watch opened. */
  identity: string;
  workspaces: Set<string>;
  handle: DirectoryWatchHandle;
  /** Last branch seen or announced; null is a detached HEAD, undefined is not read yet. */
  branch: string | null | undefined;
  /** Bursts of HEAD writes, each ending in one branch read. */
  branchBurst: BurstSchedule;
  /** Bursts of index and ref writes, each ending in one `workspace_files_changed` per workspace. */
  statusBurst: BurstSchedule;
  reading: boolean;
  recheck: boolean;
}

/**
 * Git dir entries whose write changes what `git status` reports without
 * touching the worktree: `index` for staging, `HEAD.lock` for every commit and
 * reset (Git locks HEAD to update its reflog even when HEAD keeps its branch),
 * `ORIG_HEAD` for a reset, and `HEAD` for a switch. Lock files other than
 * `HEAD.lock` are left out: a `git status` run with optional locks takes
 * `index.lock` without changing the index. Measured on macOS 2026-11-04 with
 * Node 26 and Git 2.54; the backend's own reads run with
 * `GIT_OPTIONAL_LOCKS=0` and write none of these.
 */
const statusEntryNames = new Set(["index", "HEAD", "HEAD.lock", "ORIG_HEAD"]);

const defaultWatch: DirectoryWatchFunction = (directory, listener) =>
  watch(directory, { persistent: false }, (eventType, filename) => listener(eventType, filename));

/**
 * Publishes `workspace_branch_changed` with `origin: "observed"` when a
 * registered checkout's HEAD moves to another branch, whoever moved it, and
 * `workspace_files_changed` when a stage, commit, or reset outside AgentRoom
 * changes what Git status reports (see `statusEntryNames`).
 *
 * It watches each distinct git dir, not the HEAD file: Git replaces HEAD by
 * renaming `HEAD.lock` over it, which kills a file watch after one event. Only
 * events named exactly `HEAD` read the branch, because every commit takes
 * `HEAD.lock` without rewriting HEAD. A HEAD write does not mean the branch
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
  /** Workspaces whose watch dropped, so index and ref writes before it reopens went unseen. */
  private readonly interrupted = new Set<string>();
  /** Workspaces that should be watched; an attach that finishes after a removal checks this. */
  private readonly registered = new Set<string>();
  private readonly watchDirectory: DirectoryWatchFunction;
  private readonly directoryIdentity: (path: string) => Promise<string | undefined>;
  private readonly debounceMs: number;
  private readonly minPublishIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly reconcileIntervalMs: number;
  /** Reads still running; close waits for them so no Git command outlives shutdown. */
  private readonly work: BackgroundWork;
  private readonly failures: WatchFailureReporter;
  private unsubscribe?: () => void;
  private reconcileTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: WorkspaceHeadWatcherDeps) {
    this.watchDirectory = deps.watch ?? defaultWatch;
    this.directoryIdentity = deps.directoryIdentity ?? directoryIdentity;
    this.debounceMs = deps.debounceMs ?? 300;
    this.minPublishIntervalMs = deps.minPublishIntervalMs ?? 1000;
    this.maxWaitMs = deps.maxWaitMs ?? 1000;
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000;
    this.work = new BackgroundWork(deps.onError);
    this.failures = new WatchFailureReporter(deps.onError);
  }

  async start(): Promise<void> {
    this.unsubscribe = this.deps.eventBus.subscribe((event) => {
      const workspaceId = workspaceIdOf(event.payload);
      if (!workspaceId) return;
      switch (event.type) {
        case "workspace_registered":
          this.work.track(this.attach(workspaceId));
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
    this.reconcileTimer = setInterval(() => this.work.track(this.reconcile()), this.reconcileIntervalMs);
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
    this.interrupted.clear();
    this.registered.clear();
    this.failures.clear();
    await this.work.settle();
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
    // Index or ref writes may have landed while no watch was open.
    if (this.interrupted.delete(workspaceId)) group.statusBurst.schedule();
    if (group.branch === undefined) await this.readBaseline(group, workspaceId);
  }

  private detach(workspaceId: string): void {
    this.registered.delete(workspaceId);
    this.unwatched.delete(workspaceId);
    this.interrupted.delete(workspaceId);
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
        if (filename === null || filename === "HEAD") group.branchBurst.schedule();
        if (filename === null || statusEntryNames.has(filename)) group.statusBurst.schedule();
      });
      const timing = { debounceMs: this.debounceMs, minIntervalMs: this.minPublishIntervalMs, maxWaitMs: this.maxWaitMs };
      const opened: HeadGroup = {
        gitDir,
        identity,
        workspaces: new Set(),
        handle,
        branch: undefined,
        branchBurst: new BurstSchedule(timing, () => this.work.track(this.check(opened))),
        statusBurst: new BurstSchedule(timing, () => this.work.track(this.publishStatusChange(opened))),
        reading: false,
        recheck: false
      };
      group = opened;
      handle.on("error", (error) => {
        if (this.groups.get(gitDir) !== opened) return;
        this.failures.failed(gitDir, error);
        this.dropGroup(opened);
      });
    } catch (error) {
      this.failures.failed(gitDir, error);
      return undefined;
    }
    this.groups.set(gitDir, group);
    this.failures.recovered(gitDir);
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
        if (!this.closed) group.branchBurst.schedule();
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
    group.branchBurst.markFired();

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

  /** Tells each workspace in the checkout to re-read Git status after an index or ref write. */
  private async publishStatusChange(group: HeadGroup): Promise<void> {
    if (this.closed || this.groups.get(group.gitDir) !== group) return;
    group.statusBurst.markFired();
    for (const workspaceId of [...group.workspaces]) {
      const workspace = await this.deps.registry.findByIdWithoutGitRefresh(workspaceId);
      if (!workspace || this.closed || this.groupFor(workspaceId) !== group) continue;
      publishWorkspaceFilesChanged(this.deps.eventBus, workspace);
    }
  }

  /** Stops watching a git dir that is gone or broken, keeping its workspaces queued for the reconcile pass. */
  private dropGroup(group: HeadGroup): void {
    this.removeGroup(group);
    for (const workspaceId of group.workspaces) {
      this.groupOf.delete(workspaceId);
      if (!this.registered.has(workspaceId)) continue;
      this.unwatched.add(workspaceId);
      this.interrupted.add(workspaceId);
    }
  }

  private removeGroup(group: HeadGroup): void {
    this.closeGroup(group);
    this.groups.delete(group.gitDir);
  }

  private closeGroup(group: HeadGroup): void {
    group.branchBurst.cancel();
    group.statusBurst.cancel();
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
