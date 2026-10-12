import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/EventBus";
import type { SketchDocumentChangedPayload } from "../events/eventTypes";
import type { WorkspaceTarget } from "../workspace/explorer/paths";
import { normalizeWorkspaceRelativePath } from "../workspace/explorer/paths";
import { SketchWorkspaceFiles, repositorySketchBytes, sketchDigest, changed, type SketchFile, type SketchFileStat } from "./SketchWorkspaceFiles";
import { SketchRepositoryJournal, auxiliary, SKETCH_MAX_FILE_VERSIONS, type SketchFileVersionEntry } from "./SketchRepositoryJournal";
import { SketchServiceError } from "./sketchErrors";
import { createSketchState, evaluateSketchCommit, undoSketchTransaction, redoSketchTransaction, type SketchDocument, type SketchHistoryEntry, type SketchState } from "./core";
import { KeyedSerial } from "./KeyedSerial";

export type RepositorySketchEditKind = "commit" | "undo" | "redo";

const applyEdit: Record<RepositorySketchEditKind, (state: SketchState, request: Parameters<typeof evaluateSketchCommit>[1]) => ReturnType<typeof evaluateSketchCommit>> = {
  commit: evaluateSketchCommit,
  undo: undoSketchTransaction,
  redo: redoSketchTransaction
};

export interface RepositorySketchEdit {
  requestId: string;
  baseRevision: number;
  fileVersion: string;
  label?: string;
  operations?: unknown[];
}
/** The agent behind an agent edit. Only backend tool handlers construct it. */
export interface RepositorySketchAgent {
  runnerId: string;
  sessionId: string;
  turnId: string;
  /**
   * Checked under the file lock before the edit applies; a returned error
   * refuses it. The agent tools use it to undo only their own steps and to
   * refuse a confirmed clear after the sketch changed.
   */
  guard?(state: SketchState): SketchServiceError | undefined;
}

/** What the sketch index hears after a published change. */
export interface RepositorySketchChange {
  workspaceId: string;
  path: string;
  actorKind: "human" | "agent";
  /** Absent for a deleted sketch. */
  document?: SketchDocument;
  fileVersion?: string;
  /** The identity `fileVersion` was computed from, so the index never pairs it with a later stat. */
  stat?: SketchFileStat;
  previousPath?: string;
}
export class RepositorySketchService {
  private readonly queue = new KeyedSerial();
  constructor(private readonly deps: {
    files: SketchWorkspaceFiles;
    journal: SketchRepositoryJournal;
    eventBus: EventBus;
    invalidate(workspaceId: string): void;
    /** Told about every change this service publishes, for the sketch index. */
    changed?(change: RepositorySketchChange): void;
  }) {}

  /**
   * Creation holds the workspace lock because the suffix ladder probes several
   * candidate names. Publication is create-only, so no edit can reach a path
   * before it exists and a racing writer's file is never replaced.
   */
  async create(workspaceId: string, name: string, agent?: RepositorySketchAgent) {
    return this.queue.run(workspaceId, async () => {
      const target = await this.deps.files.target(workspaceId);
      const document = createSketchState(`sketch-${randomUUID()}`).document;
      const preferred = await this.deps.files.preferredPath(target, name);
      for (let ordinal = 1; ordinal <= 5; ordinal++) {
        const path = ordinal === 1 ? preferred : preferred.replace(/\.sketch\.json$/, `-${ordinal}.sketch.json`);
        if (await this.deps.files.exists(target, path)) continue;
        let file: SketchFile;
        try { file = await this.deps.files.write(target, path, document); }
        catch (error) {
          if (error instanceof SketchServiceError && error.code === "file_exists") continue;
          throw error;
        }
        this.publish(target, path, file, "created", agent);
        return this.read(workspaceId, path);
      }
      throw new SketchServiceError("Sketch names are occupied; choose another name", 409, "name_collision");
    });
  }

  /**
   * Renames a sketch inside its workspace. The workspace lock orders it with
   * creation, and the file lock with edits to the old path. The auxiliary
   * history moves to the new path's key, so undo keeps working.
   */
  async rename(workspaceId: string, path: string, newPath: string, fileVersion: string, agent: RepositorySketchAgent) {
    path = normalizeWorkspaceRelativePath(path);
    newPath = normalizeWorkspaceRelativePath(newPath);
    return this.queue.run(workspaceId, () => this.queue.run(this.fileLock(workspaceId, path), async () => {
      const target = await this.deps.files.target(workspaceId);
      const before = await this.deps.files.read(target, path);
      const { state } = await this.state(this.key(target, path), before);
      const renamed = await this.deps.files.rename(target, path, newPath, fileVersion);
      // The link changed the file's identity, so only the current revision
      // keeps a known file version; the revision log still holds.
      await this.deps.journal.save(this.key(target, newPath), auxiliary(state, renamed.fileVersion,
        [{ revision: renamed.document.revision, fileVersion: renamed.fileVersion }]));
      await this.deps.journal.remove(this.key(target, path));
      this.publish(target, newPath, renamed, "renamed", agent, path);
      return this.readUnlocked(workspaceId, newPath);
    }));
  }

  /** Deletes a sketch and its auxiliary history. Recovery can never bring it back. */
  async delete(workspaceId: string, path: string, fileVersion: string, agent: RepositorySketchAgent): Promise<void> {
    path = normalizeWorkspaceRelativePath(path);
    await this.queue.run(workspaceId, () => this.queue.run(this.fileLock(workspaceId, path), async () => {
      const target = await this.deps.files.target(workspaceId);
      const file = await this.deps.files.read(target, path);
      await this.deps.files.remove(target, path, fileVersion);
      await this.deps.journal.remove(this.key(target, path));
      this.publish(target, path, file, "deleted", agent);
    }));
  }

  async read(workspaceId: string, path: string) {
    path = normalizeWorkspaceRelativePath(path);
    return this.queue.run(this.fileLock(workspaceId, path), () => this.readUnlocked(workspaceId, path));
  }

  async edit(workspaceId: string, path: string, kind: RepositorySketchEditKind, input: RepositorySketchEdit) {
    return (await this.editDocument(workspaceId, path, kind, input)).response;
  }

  /**
   * An agent's edit. It commits as `actor: { kind: "agent" }` with the turn id,
   * and publishes only `sketch_document_changed` naming the session and turn:
   * `workspace_file_written` is the human-write signal other trackers read.
   * Also returns the resulting document and the ids the revision changed, so
   * the tool can describe them without another read.
   */
  async editAsAgent(workspaceId: string, path: string, kind: RepositorySketchEditKind, input: RepositorySketchEdit, agent: RepositorySketchAgent) {
    return this.editDocument(workspaceId, path, kind, input, agent);
  }

  private async editDocument(workspaceId: string, path: string, kind: RepositorySketchEditKind, input: RepositorySketchEdit, agent?: RepositorySketchAgent) {
    path = normalizeWorkspaceRelativePath(path);
    return this.queue.run(this.fileLock(workspaceId, path), async () => {
      const target = await this.deps.files.target(workspaceId);
      const file = await this.deps.files.read(target, path);
      const key = this.key(target, path);
      const { state, fileVersions } = await this.state(key, file);
      const actor = agent ? { kind: "agent", runnerId: agent.runnerId } : { kind: "human" };
      const request = { requestId: input.requestId, baseRevision: input.baseRevision, label: input.label, actor,
        ...(agent ? { turnId: agent.turnId } : {}), ...(kind === "commit" ? { operations: input.operations } : {}) };
      const replay = state.receipts.some((r) => r.requestId === input.requestId);
      // An older file version is accepted only when this service produced it
      // at the request's base revision and has logged every change since, so
      // an external edit, even one that reused the revision, is still refused.
      const knownVersion = file.fileVersion === input.fileVersion ||
        fileVersions.some((entry) => entry.revision === input.baseRevision && entry.fileVersion === input.fileVersion);
      if (!replay && !knownVersion) throw changed();
      const refusal = replay ? undefined : agent?.guard?.(state);
      if (refusal) throw refusal;
      const result = applyEdit[kind](state, request);
      if (!result.ok) {
        const { code, message, ...details } = result.error;
        throw new SketchServiceError(message, ["stale_revision", "request_id_conflict", "outcome_unknown", "nothing_to_undo", "nothing_to_redo"].includes(code) ? 409 : 422, code, details);
      }
      let saved = file;
      if (!replay) {
        const bytes = repositorySketchBytes(result.state.document);
        await this.deps.journal.save(key, { ...auxiliary(state, file.fileVersion, fileVersions), pending: {
          beforeVersion: file.fileVersion, digest: sketchDigest(bytes), document: result.state.document,
          history: result.state.history, receipts: result.state.receipts, expiredRequestIds: result.state.expiredRequestIds,
          ...(result.state.revisionLog === undefined ? {} : { revisionLog: result.state.revisionLog }), fileVersions
        } });
        saved = await this.deps.files.write(target, path, result.state.document, file.fileVersion);
        await this.deps.journal.save(key, auxiliary(result.state, saved.fileVersion,
          appendFileVersion(fileVersions, result.state.document.revision, saved.fileVersion)));
        this.publish(target, path, saved, kind, agent);
      }
      const logged = result.state.revisionLog?.entries.find((entry) => entry.revision === result.receipt.revision);
      return {
        response: { receipt: result.receipt, revision: result.receipt.revision, fileVersion: saved.fileVersion,
          undoDepth: result.state.history.undo.length, redoDepth: result.state.history.redo.length,
          ...historyHeads(result.state) },
        document: result.state.document,
        // Undefined when the revision touched every object or is not logged.
        changedObjectIds: logged !== undefined && "objectIds" in logged ? logged.objectIds : undefined
      };
    });
  }

  /** Explicit recovery drops only auxiliary history after the user has inspected current bytes. */
  async resetHistory(workspaceId: string, path: string, fileVersion: string) {
    path = normalizeWorkspaceRelativePath(path);
    return this.queue.run(this.fileLock(workspaceId, path), async () => {
      const target = await this.deps.files.target(workspaceId);
      const file = await this.deps.files.read(target, path);
      if (file.fileVersion !== fileVersion) throw changed();
      const state = createSketchState(file.document.sketchId);
      state.document = file.document;
      await this.deps.journal.save(this.key(target, path), auxiliary(state, file.fileVersion));
      return this.readUnlocked(workspaceId, path);
    });
  }

  private async readUnlocked(workspaceId: string, path: string) {
    const target = await this.deps.files.target(workspaceId);
    path = normalizeWorkspaceRelativePath(path);
    const file = await this.deps.files.read(target, path);
    let loaded;
    try { loaded = await this.state(this.key(target, path), file); }
    catch (error) {
      if (!(error instanceof SketchServiceError) || error.code !== "outcome_unknown") throw error;
      const state = createSketchState(file.document.sketchId);
      state.document = file.document;
      loaded = { state, historyReset: true, outcomeUnknown: true };
    }
    const { state, historyReset } = loaded;
    return { workspaceId, path, sketchId: file.document.sketchId, revision: file.document.revision,
      document: file.document, fileVersion: file.fileVersion, undoDepth: state.history.undo.length,
      redoDepth: state.history.redo.length, ...historyHeads(state), historyReset, outcomeUnknown: "outcomeUnknown" in loaded };
  }

  private async state(key: string, file: SketchFile): Promise<{ state: SketchState; historyReset: boolean; fileVersions: SketchFileVersionEntry[] }> {
    let stored = await this.deps.journal.load(key);
    if (stored?.pending) {
      const pending = stored.pending;
      if (file.digest === pending.digest) {
        stored = { fileVersion: file.fileVersion, history: pending.history, receipts: pending.receipts, expiredRequestIds: pending.expiredRequestIds,
          ...(pending.revisionLog === undefined ? {} : { revisionLog: pending.revisionLog }),
          ...(pending.fileVersions === undefined ? {} : {
            fileVersions: appendFileVersion(pending.fileVersions, pending.document.revision, file.fileVersion) }) };
      } else if (file.fileVersion === pending.beforeVersion) {
        stored = { ...stored, pending: undefined };
      } else { throw unknownOutcome(); }
      await this.deps.journal.save(key, stored);
    }
    const state = createSketchState(file.document.sketchId);
    state.document = file.document;
    let fileVersions: SketchFileVersionEntry[] = [];
    if (stored?.fileVersion === file.fileVersion) {
      state.history = stored.history;
      state.receipts = stored.receipts;
      state.expiredRequestIds = stored.expiredRequestIds;
      if (stored.revisionLog !== undefined) state.revisionLog = stored.revisionLog;
      fileVersions = stored.fileVersions ?? [];
    }
    // The versions describe this exact file only when the newest one is it.
    const newest = fileVersions.at(-1);
    if (newest?.fileVersion !== file.fileVersion || newest.revision !== file.document.revision) {
      fileVersions = [{ revision: file.document.revision, fileVersion: file.fileVersion }];
    }
    return { state, historyReset: stored !== undefined && stored.fileVersion !== file.fileVersion, fileVersions };
  }

  private key(target: WorkspaceTarget, path: string): string { return `${target.workspaceRoot}\0${path}`; }
  /** Edits to different files in one workspace run concurrently; one file's edits run in order. */
  private fileLock(workspaceId: string, path: string): string { return `${workspaceId}\0${path}`; }
  private publish(target: WorkspaceTarget, path: string, file: SketchFile, kind: SketchDocumentChangedPayload["kind"],
    agent?: RepositorySketchAgent, previousPath?: string): void {
    this.deps.invalidate(target.workspaceId);
    if (!agent) {
      this.deps.eventBus.publish("workspace_file_written", { workspaceId: target.workspaceId, workspacePath: target.workspacePath, path,
        sizeBytes: Buffer.byteLength(repositorySketchBytes(file.document)), created: kind === "created" });
    }
    const payload: SketchDocumentChangedPayload = { workspaceId: target.workspaceId, path,
      sketchId: file.document.sketchId, revision: file.document.revision, kind,
      ...(previousPath === undefined ? {} : { previousPath }),
      ...(agent ? { actorKind: "agent", sessionId: agent.sessionId, turnId: agent.turnId } : { actorKind: "human" }) };
    this.deps.eventBus.publish("sketch_document_changed", payload);
    this.deps.changed?.({ workspaceId: target.workspaceId, path, actorKind: payload.actorKind,
      ...(kind === "deleted" ? {} : { document: file.document, fileVersion: file.fileVersion, stat: file.stat }),
      ...(previousPath === undefined ? {} : { previousPath }) });
  }
}
function appendFileVersion(versions: SketchFileVersionEntry[], revision: number, fileVersion: string): SketchFileVersionEntry[] {
  return [...versions, { revision, fileVersion }].slice(-SKETCH_MAX_FILE_VERSIONS);
}
/** What the next undo and redo would reverse or replay, so a client can label them. */
function historyHeads(state: SketchState) {
  const head = (entries: SketchHistoryEntry[]) => {
    const entry = entries.at(-1);
    return entry === undefined ? null : { label: entry.label, actorKind: entry.actor.kind };
  };
  return { undoHead: head(state.history.undo), redoHead: head(state.history.redo) };
}
function unknownOutcome(): SketchServiceError {
  return new SketchServiceError("Sketch save outcome is unknown; inspect the workspace file before retrying", 409, "outcome_unknown");
}
