import { watch } from "node:fs";
import type { EventBus } from "../../events/EventBus";
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
import { hasHiddenPathSegment } from "./bounds";

export interface WorkspaceTreeWatcherDeps {
  registry: Pick<LocalWorkspaceRegistry, "listWithoutGitRefresh" | "findByIdWithoutGitRefresh">;
  eventBus: Pick<EventBus, "publishLive" | "subscribe">;
  /** Drops the workspace's cached file index after an entry appears, vanishes, or moves. */
  invalidateFileIndex(workspaceId: string): void;
  watch?: DirectoryWatchFunction;
  /**
   * The workspace root's device and inode, or undefined when it is gone. The
   * reconcile pass drops a watch whose root vanished or was replaced.
   */
  directoryIdentity?: (path: string) => Promise<string | undefined>;
  /** Reports a failure no caller waits on: a watch that would not open or broke, or a subscriber throwing. */
  onError?: (error: unknown) => void;
  debounceMs?: number;
  minPublishIntervalMs?: number;
  maxWaitMs?: number;
  reconcileIntervalMs?: number;
}

interface TreeWatch {
  workspaceId: string;
  path: string;
  identity: string;
  handle: DirectoryWatchHandle;
  burst: BurstSchedule;
  /** A create, delete, or rename landed in the pending burst, so the file index is stale. */
  structural: boolean;
}

const defaultWatch: DirectoryWatchFunction = (directory, listener) =>
  watch(directory, { persistent: false, recursive: true }, (eventType, filename) => listener(eventType, filename));

/**
 * Publishes `workspace_files_changed` when anything a tree read could show
 * changes inside a registered workspace, whoever changed it. It holds one
 * recursive watch per registered workspace root and counts a change only when
 * its relative path has no segment the tree read hides. The event's timing and
 * delivery are in API.md "Observed file changes"; the filter and its trust
 * reasoning are in TRUST_AND_SAFETY.md "Workspace files".
 */
export class WorkspaceTreeWatcher {
  private readonly watches = new Map<string, TreeWatch>();
  /** Registered workspaces without a watch: the root is missing, or the watch failed. */
  private readonly unwatched = new Set<string>();
  /** Workspaces that should be watched; an attach that finishes after a removal checks this. */
  private readonly registered = new Set<string>();
  /** Workspaces whose watch dropped, so changes made before it reopens went unseen. */
  private readonly interrupted = new Set<string>();
  private readonly watchDirectory: DirectoryWatchFunction;
  private readonly directoryIdentity: (path: string) => Promise<string | undefined>;
  private readonly debounceMs: number;
  private readonly minPublishIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly work: BackgroundWork;
  private readonly failures: WatchFailureReporter;
  private unsubscribe?: () => void;
  private reconcileTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: WorkspaceTreeWatcherDeps) {
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
      if (event.type === "workspace_registered") this.work.track(this.attach(workspaceId));
      else if (event.type === "workspace_removed") this.detach(workspaceId);
    });
    const workspaces = await this.deps.registry.listWithoutGitRefresh();
    await Promise.all(workspaces.map((workspace) => this.attach(workspace.id)));
    this.reconcileTimer = setInterval(() => this.work.track(this.reconcile()), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  /** Stops every watch and timer, then waits for work already running. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const entry of this.watches.values()) this.closeWatch(entry);
    this.watches.clear();
    this.unwatched.clear();
    this.registered.clear();
    this.interrupted.clear();
    this.failures.clear();
    await this.work.settle();
  }

  /** Retries unwatched workspaces and drops watches whose root is gone or replaced. */
  async reconcile(): Promise<void> {
    if (this.closed) return;
    for (const entry of [...this.watches.values()]) {
      const identity = await this.directoryIdentity(entry.path);
      if (identity !== entry.identity && this.watches.get(entry.workspaceId) === entry) this.dropWatch(entry);
    }
    await Promise.all([...this.unwatched].map((workspaceId) => this.attach(workspaceId)));
  }

  private async attach(workspaceId: string): Promise<void> {
    if (this.closed || this.watches.has(workspaceId)) return;
    this.registered.add(workspaceId);
    this.unwatched.add(workspaceId);
    const workspace = await this.deps.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace || !this.stillWanted(workspaceId)) return;
    const identity = await this.directoryIdentity(workspace.path);
    if (!identity || !this.stillWanted(workspaceId)) return;
    const entry = this.openWatch(workspaceId, workspace.path, identity);
    if (!entry) return;
    this.watches.set(workspaceId, entry);
    this.unwatched.delete(workspaceId);
    this.failures.recovered(workspaceId);
    if (this.interrupted.delete(workspaceId)) {
      // Anything may have changed while no watch was open, so clients re-read.
      entry.structural = true;
      entry.burst.schedule();
    }
  }

  private detach(workspaceId: string): void {
    this.registered.delete(workspaceId);
    this.unwatched.delete(workspaceId);
    this.interrupted.delete(workspaceId);
    this.failures.recovered(workspaceId);
    const entry = this.watches.get(workspaceId);
    if (!entry) return;
    this.closeWatch(entry);
    this.watches.delete(workspaceId);
  }

  private stillWanted(workspaceId: string): boolean {
    return !this.closed && this.registered.has(workspaceId) && !this.watches.has(workspaceId);
  }

  private openWatch(workspaceId: string, path: string, identity: string): TreeWatch | undefined {
    let entry: TreeWatch | undefined;
    try {
      const handle = this.watchDirectory(path, (eventType, filename) => {
        if (!entry || this.closed || this.watches.get(workspaceId) !== entry) return;
        // A null name is a change the platform could not attribute; count it.
        if (filename !== null && !isVisibleChange(filename)) return;
        if (eventType === "rename") entry.structural = true;
        entry.burst.schedule();
      });
      const burst = new BurstSchedule(
        { debounceMs: this.debounceMs, minIntervalMs: this.minPublishIntervalMs, maxWaitMs: this.maxWaitMs },
        () => {
          if (entry) this.publish(entry);
        }
      );
      entry = { workspaceId, path, identity, handle, burst, structural: false };
      handle.on("error", (error) => {
        if (!entry || this.watches.get(workspaceId) !== entry) return;
        this.failures.failed(workspaceId, error);
        this.dropWatch(entry);
      });
    } catch (error) {
      this.failures.failed(workspaceId, error);
      return undefined;
    }
    return entry;
  }

  private publish(entry: TreeWatch): void {
    if (this.closed || this.watches.get(entry.workspaceId) !== entry) return;
    entry.burst.markFired();
    if (entry.structural) {
      entry.structural = false;
      this.deps.invalidateFileIndex(entry.workspaceId);
    }
    try {
      publishWorkspaceFilesChanged(this.deps.eventBus, { id: entry.workspaceId, path: entry.path });
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  /** Stops watching a root that is gone or broken, keeping its workspace queued for the reconcile pass. */
  private dropWatch(entry: TreeWatch): void {
    this.closeWatch(entry);
    this.watches.delete(entry.workspaceId);
    if (!this.registered.has(entry.workspaceId)) return;
    this.unwatched.add(entry.workspaceId);
    this.interrupted.add(entry.workspaceId);
  }

  private closeWatch(entry: TreeWatch): void {
    entry.burst.cancel();
    try {
      entry.handle.close();
    } catch {
      // Already closed.
    }
  }
}

/** Whether a watched relative path is one the tree read could list. */
export function isVisibleChange(filename: string): boolean {
  const relative = filename.replaceAll("\\", "/").replace(/^\/+/, "");
  if (relative === "") return true;
  return !hasHiddenPathSegment(relative);
}
