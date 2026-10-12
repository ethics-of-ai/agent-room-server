import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRoomEvent } from "../../events/eventTypes";
import { normalizeWorkspaceRelativePath, type WorkspaceTarget } from "../../workspace/explorer/paths";
import type { RepositorySketchChange } from "../RepositorySketchService";
import type { SketchWorkspaceFiles } from "../SketchWorkspaceFiles";
import { SketchServiceError } from "../sketchErrors";
import { SKETCH_INDEX_SCHEMA_VERSION, type SketchIndexEntry, type SketchIndexStore, type StoredSketchIndex } from "./SketchIndexStore";
import { matchSketchReference, sketchTitleFromPath, type SketchResolution } from "./sketchReference";
import { KeyedSerial } from "../KeyedSerial";

/** The most sketch files one workspace scan keeps, matching the client's menu. */
export const SKETCH_INDEX_SCAN_LIMIT = 200;

/**
 * The backend's list of sketches per registered workspace. The repository
 * file stays the only source of geometry; the index holds identity, title,
 * revision, size, and who changed it last, so a sketch can be found by id or
 * title.
 *
 * AgentRoom has no file watcher, so three triggers keep it current. The
 * repository service records every change it makes. Every list rescans the
 * workspace through the file index's ignore rules, re-reading only files whose
 * size, modification time, or inode changed. A file-route or git event marks
 * the workspace for a rescan on its next lookup, and a settled turn's git diff
 * re-reads the sketch paths it names at once, which catches an agent's raw
 * writes. Work on one workspace runs one step at a time.
 */
export class SketchIndex {
  private readonly queue = new KeyedSerial();
  private readonly dirty = new Set<string>();
  private readonly loaded = new Map<string, StoredSketchIndex>();

  constructor(private readonly deps: {
    store: SketchIndexStore;
    files: Pick<SketchWorkspaceFiles, "target" | "read">;
    /** A fresh enumeration of the workspace's indexable paths. */
    listPaths(workspaceId: string): Promise<{ paths: string[]; truncated: boolean }>;
  }) {}

  /** Rescan, then return the workspace's sketches. */
  list(workspaceId: string): Promise<StoredSketchIndex> {
    return this.queue.run(workspaceId, () => this.scan(workspaceId));
  }

  /**
   * Find one sketch by exact path, sketch id, or title. A marked workspace is
   * rescanned first, an exact path the index does not hold is read before the
   * answer is `unknown`, and an id or title that finds nothing triggers one
   * rescan before giving up.
   */
  resolve(workspaceId: string, reference: string): Promise<SketchResolution> {
    return this.queue.run(workspaceId, async () => {
      let scanned = false;
      let index = await this.current(workspaceId);
      if (index === undefined || this.dirty.has(workspaceId)) {
        index = await this.scan(workspaceId);
        scanned = true;
      }
      let match = matchSketchReference(index.entries, reference);
      if (match.kind !== "unknown") return match;
      const path = exactSketchPath(reference);
      if (path !== undefined) {
        const target = await this.deps.files.target(workspaceId);
        const entry = await this.entryFor(target, path, undefined);
        if (entry === undefined) return match;
        await this.upsert(workspaceId, index, [entry], []);
        return { kind: "found", entry };
      }
      if (!scanned) {
        index = await this.scan(workspaceId);
        match = matchSketchReference(index.entries, reference);
      }
      return match;
    });
  }

  /**
   * Record a change the repository service just published: an edit or a
   * creation, a rename (the entry moves to the new path), or a deletion.
   */
  recordChange(change: RepositorySketchChange): Promise<void> {
    const { workspaceId, path, document } = change;
    return this.queue.run(workspaceId, async () => {
      const index = await this.current(workspaceId) ?? this.empty(workspaceId);
      const removals = [...(change.previousPath ? [change.previousPath] : []), ...(document ? [] : [path])];
      if (!document) return this.upsert(workspaceId, index, [], removals);
      const stat = change.stat ?? await statOf(await this.deps.files.target(workspaceId), path);
      const entry: SketchIndexEntry = {
        path, title: sketchTitleFromPath(path), state: "ok", sketchId: document.sketchId, revision: document.revision,
        objectCount: document.objects.length, lastChangedAt: new Date().toISOString(), lastActorKind: change.actorKind,
        ...(stat ? { stat } : {}), ...(change.fileVersion ? { fileVersion: change.fileVersion } : {})
      };
      await this.upsert(workspaceId, index, [entry], removals);
    });
  }

  /** Re-read named paths now, dropping those that are gone. */
  reread(workspaceId: string, paths: readonly string[]): Promise<void> {
    return this.queue.run(workspaceId, async () => {
      const index = await this.current(workspaceId);
      if (index === undefined) return;
      const target = await this.deps.files.target(workspaceId);
      const upserts: SketchIndexEntry[] = [];
      const removals: string[] = [];
      for (const path of new Set(paths)) {
        const entry = await this.entryFor(target, path, undefined);
        if (entry) upserts.push(entry); else removals.push(path);
      }
      await this.upsert(workspaceId, index, upserts, removals);
    });
  }

  markDirty(workspaceId: string): void {
    this.dirty.add(workspaceId);
  }

  /** Drop an unregistered workspace's entries. Never touches its files. */
  forget(workspaceId: string): Promise<void> {
    return this.queue.run(workspaceId, async () => {
      this.loaded.delete(workspaceId);
      this.dirty.delete(workspaceId);
      await this.deps.store.remove(workspaceId);
    });
  }

  /** Follow the events that can change a workspace's sketches. Returns the unsubscribe. */
  attach(
    bus: { subscribe(handler: (event: AgentRoomEvent) => void): () => void },
    workspaceOfSession: (sessionId: string) => string | undefined
  ): () => void {
    return bus.subscribe((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : undefined;
      switch (event.type) {
        case "workspace_file_written":
        case "workspace_file_deleted":
        case "workspace_entry_renamed":
        case "workspace_entry_moved":
        case "workspace_entry_copied":
          if (workspaceId && (payload.entryType === "directory" || [payload.path, payload.oldPath, payload.sourcePath].some(isSketchPath))) {
            this.markDirty(workspaceId);
          }
          return;
        case "workspace_git_operation":
        case "workspace_branch_changed":
          if (workspaceId) this.markDirty(workspaceId);
          return;
        case "workspace_removed":
          if (workspaceId) void this.forget(workspaceId).catch(() => {});
          return;
        case "coding_diff_updated": {
          const sessionWorkspace = typeof payload.sessionId === "string" ? workspaceOfSession(payload.sessionId) : undefined;
          const files = Array.isArray(payload.files) ? payload.files as Array<{ path?: unknown; oldPath?: unknown }> : [];
          const paths = files.flatMap((file) => [file.path, file.oldPath]).filter(isSketchPath);
          if (sessionWorkspace && paths.length > 0) void this.reread(sessionWorkspace, paths).catch(() => this.markDirty(sessionWorkspace));
          return;
        }
      }
    });
  }

  private async scan(workspaceId: string): Promise<StoredSketchIndex> {
    const target = await this.deps.files.target(workspaceId);
    const previous = await this.current(workspaceId);
    const { paths, truncated } = await this.deps.listPaths(workspaceId);
    const sketchPaths = paths.filter(isSketchPath);
    const byPath = new Map(previous?.entries.map((entry) => [entry.path, entry]));
    const entries: SketchIndexEntry[] = [];
    for (const path of sketchPaths.slice(0, SKETCH_INDEX_SCAN_LIMIT)) {
      const entry = await this.entryFor(target, path, byPath.get(path));
      if (entry) entries.push(entry);
    }
    const next: StoredSketchIndex = { schemaVersion: SKETCH_INDEX_SCHEMA_VERSION, workspaceId, entries, total: sketchPaths.length, truncated };
    await this.persist(next);
    this.dirty.delete(workspaceId);
    return next;
  }

  /** The entry for one path, reusing `previous` when the file's identity is unchanged; undefined when the file is gone. */
  private async entryFor(target: WorkspaceTarget, path: string, previous: SketchIndexEntry | undefined): Promise<SketchIndexEntry | undefined> {
    const stat = await statOf(target, path);
    if (stat === undefined) return undefined;
    if (previous?.stat && previous.stat.size === stat.size && previous.stat.mtimeMs === stat.mtimeMs && previous.stat.ino === stat.ino) {
      return previous;
    }
    const title = sketchTitleFromPath(path);
    try {
      const file = await this.deps.files.read(target, path);
      return { path, title, state: "ok", sketchId: file.document.sketchId, revision: file.document.revision,
        objectCount: file.document.objects.length, lastChangedAt: new Date(file.stat.mtimeMs).toISOString(), stat: file.stat, fileVersion: file.fileVersion };
    } catch (error) {
      // Listed as invalid, not dropped, so an agent can tell the person.
      // Not a sketch location at all (gone, a symlink, or a missing parent).
      if (error instanceof SketchServiceError && ["file_missing", "invalid_path", "parent_missing"].includes(error.code)) return undefined;
      return { path, title, state: "invalid", invalidReason: error instanceof SketchServiceError ? error.code : "unreadable",
        lastChangedAt: new Date(stat.mtimeMs).toISOString(), stat };
    }
  }

  private async upsert(workspaceId: string, index: StoredSketchIndex, entries: SketchIndexEntry[], removals: string[]): Promise<void> {
    const byPath = new Map(index.entries.map((entry) => [entry.path, entry]));
    let total = index.total;
    for (const path of removals) if (byPath.delete(path)) total = Math.max(0, total - 1);
    for (const entry of entries) {
      if (byPath.has(entry.path)) byPath.set(entry.path, entry);
      else if (byPath.size < SKETCH_INDEX_SCAN_LIMIT) { byPath.set(entry.path, entry); total += 1; }
    }
    const sorted = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    await this.persist({ ...index, entries: sorted, total: Math.max(total, sorted.length) });
  }

  private async current(workspaceId: string): Promise<StoredSketchIndex | undefined> {
    const cached = this.loaded.get(workspaceId);
    if (cached) return cached;
    const stored = await this.deps.store.load(workspaceId);
    if (stored) this.loaded.set(workspaceId, stored);
    return stored;
  }

  private empty(workspaceId: string): StoredSketchIndex {
    // A change recorded before any scan: the next lookup scans for the rest.
    this.dirty.add(workspaceId);
    return { schemaVersion: SKETCH_INDEX_SCHEMA_VERSION, workspaceId, entries: [], total: 0, truncated: false };
  }

  private async persist(index: StoredSketchIndex): Promise<void> {
    this.loaded.set(index.workspaceId, index);
    await this.deps.store.save(index);
  }
}

export type { SketchResolution };

function isSketchPath(value: unknown): value is string {
  return typeof value === "string" && value.endsWith(".sketch.json");
}

/** The normalized path when a reference names a `.sketch.json` file, else undefined. */
export function exactSketchPath(reference: string): string | undefined {
  try {
    const path = normalizeWorkspaceRelativePath(reference.trim());
    return path.endsWith(".sketch.json") ? path : undefined;
  } catch {
    return undefined;
  }
}

async function statOf(target: WorkspaceTarget, path: string): Promise<{ size: number; mtimeMs: number; ino: number } | undefined> {
  try {
    const value = await lstat(join(target.workspaceRoot, path));
    return value.isFile() ? { size: value.size, mtimeMs: value.mtimeMs, ino: value.ino } : undefined;
  } catch {
    return undefined;
  }
}
