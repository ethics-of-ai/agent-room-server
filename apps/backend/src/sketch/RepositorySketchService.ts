import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/EventBus";
import type { WorkspaceTarget } from "../workspace/explorer/paths";
import { normalizeWorkspaceRelativePath } from "../workspace/explorer/paths";
import { SketchWorkspaceFiles, repositorySketchBytes, sketchDigest, changed, type SketchFile } from "./SketchWorkspaceFiles";
import { SketchRepositoryJournal, auxiliary } from "./SketchRepositoryJournal";
import { SketchServiceError } from "./sketchErrors";
import { createSketchState, evaluateSketchCommit, undoSketchTransaction, redoSketchTransaction, type SketchState } from "./core";

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
export class RepositorySketchService {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: {
    files: SketchWorkspaceFiles;
    journal: SketchRepositoryJournal;
    eventBus: EventBus;
    invalidate(workspaceId: string): void;
  }) {}

  /**
   * Creation holds the workspace lock because the suffix ladder probes several
   * candidate names. Publication is create-only, so no edit can reach a path
   * before it exists and a racing writer's file is never replaced.
   */
  async create(workspaceId: string, name: string) {
    return this.serial(workspaceId, async () => {
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
        this.publish(target, path, file, "created");
        return this.read(workspaceId, path);
      }
      throw new SketchServiceError("Sketch names are occupied; choose another name", 409, "name_collision");
    });
  }

  async read(workspaceId: string, path: string) {
    path = normalizeWorkspaceRelativePath(path);
    return this.serial(this.fileLock(workspaceId, path), () => this.readUnlocked(workspaceId, path));
  }

  async edit(workspaceId: string, path: string, kind: RepositorySketchEditKind, input: RepositorySketchEdit) {
    path = normalizeWorkspaceRelativePath(path);
    return this.serial(this.fileLock(workspaceId, path), async () => {
      const target = await this.deps.files.target(workspaceId);
      const file = await this.deps.files.read(target, path);
      const key = this.key(target, path);
      const { state } = await this.state(key, file);
      const request = { requestId: input.requestId, baseRevision: input.baseRevision, label: input.label, actor: { kind: "human" },
        ...(kind === "commit" ? { operations: input.operations } : {}) };
      const replay = state.receipts.some((r) => r.requestId === input.requestId);
      if (!replay && file.fileVersion !== input.fileVersion) throw changed();
      const result = applyEdit[kind](state, request);
      if (!result.ok) {
        const { code, message, ...details } = result.error;
        throw new SketchServiceError(message, ["stale_revision", "request_id_conflict", "outcome_unknown", "nothing_to_undo", "nothing_to_redo"].includes(code) ? 409 : 422, code, details);
      }
      let saved = file;
      if (!replay) {
        const bytes = repositorySketchBytes(result.state.document);
        await this.deps.journal.save(key, { ...auxiliary(state, file.fileVersion), pending: {
          beforeVersion: file.fileVersion, digest: sketchDigest(bytes), document: result.state.document,
          history: result.state.history, receipts: result.state.receipts, expiredRequestIds: result.state.expiredRequestIds
        } });
        saved = await this.deps.files.write(target, path, result.state.document, file.fileVersion);
        await this.deps.journal.save(key, auxiliary(result.state, saved.fileVersion));
        this.publish(target, path, saved, kind);
      }
      return { receipt: result.receipt, revision: result.receipt.revision, fileVersion: saved.fileVersion,
        undoDepth: result.state.history.undo.length, redoDepth: result.state.history.redo.length };
    });
  }

  /** Explicit recovery drops only auxiliary history after the user has inspected current bytes. */
  async resetHistory(workspaceId: string, path: string, fileVersion: string) {
    path = normalizeWorkspaceRelativePath(path);
    return this.serial(this.fileLock(workspaceId, path), async () => {
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
      redoDepth: state.history.redo.length, historyReset, outcomeUnknown: "outcomeUnknown" in loaded };
  }

  private async state(key: string, file: SketchFile): Promise<{ state: SketchState; historyReset: boolean }> {
    let stored = await this.deps.journal.load(key);
    if (stored?.pending) {
      const pending = stored.pending;
      if (file.digest === pending.digest) {
        stored = { fileVersion: file.fileVersion, history: pending.history, receipts: pending.receipts, expiredRequestIds: pending.expiredRequestIds };
      } else if (file.fileVersion === pending.beforeVersion) {
        stored = { ...stored, pending: undefined };
      } else { throw unknownOutcome(); }
      await this.deps.journal.save(key, stored);
    }
    const state = createSketchState(file.document.sketchId);
    state.document = file.document;
    if (stored?.fileVersion === file.fileVersion) {
      state.history = stored.history;
      state.receipts = stored.receipts;
      state.expiredRequestIds = stored.expiredRequestIds;
    }
    return { state, historyReset: stored !== undefined && stored.fileVersion !== file.fileVersion };
  }

  private key(target: WorkspaceTarget, path: string): string { return `${target.workspaceRoot}\0${path}`; }
  /** Edits to different files in one workspace run concurrently; one file's edits run in order. */
  private fileLock(workspaceId: string, path: string): string { return `${workspaceId}\0${path}`; }
  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(operation, operation);
    this.chains.set(key, next);
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); }).catch(() => {});
    return next;
  }
  private publish(target: WorkspaceTarget, path: string, file: SketchFile, kind: string): void {
    this.deps.invalidate(target.workspaceId);
    this.deps.eventBus.publish("workspace_file_written", { workspaceId: target.workspaceId, workspacePath: target.workspacePath, path,
      sizeBytes: Buffer.byteLength(repositorySketchBytes(file.document)), created: kind === "created" });
    this.deps.eventBus.publish("sketch_document_changed", { workspaceId: target.workspaceId, path,
      sketchId: file.document.sketchId, revision: file.document.revision, kind, actorKind: "human" });
  }
}
function unknownOutcome(): SketchServiceError {
  return new SketchServiceError("Sketch save outcome is unknown; inspect the workspace file before retrying", 409, "outcome_unknown");
}
