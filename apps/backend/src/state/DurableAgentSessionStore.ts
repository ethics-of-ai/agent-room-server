import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DurableAgentSessionDocument, ServiceConfig } from "../domain/models";
import {
  DURABLE_AGENT_SESSION_SCHEMA_VERSION,
  durableAgentSessionDocumentSchema
} from "../domain/schemas";
import { logger } from "../logging/logger";

const DIRECTORY_NAME = "sessions";
const FILE_SUFFIX = ".json";
const TEMP_SUFFIX = ".tmp";
// A session id is used as a file name. The service mints `agent-session-<uuid>`;
// this refuses anything that could leave the directory.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What `initialize` found on disk. Counts describe files left in place. */
export interface DurableAgentSessionInventory {
  /**
   * Documents this build can serve: written at this schema version, or at an
   * older one and migrated in memory.
   */
  documents: DurableAgentSessionDocument[];
  /**
   * How many of `documents` were written at an older schema version. They are
   * migrated whole in memory and rewritten at this version by their next
   * change, never on read: reading a thread must not change it.
   */
  migrated: number;
  /**
   * Files whose `schemaVersion` is newer than this build knows. Left exactly
   * as they are: the repair is to update the app, and a thread a newer build
   * wrote is not damage to reset.
   */
  unsupported: number;
  /**
   * Files at a known version that did not validate, files that are not JSON,
   * and files whose name does not match the session id inside. Left in place
   * and logged; deleting them would decide for the operator.
   */
  unreadable: number;
}

/**
 * One acknowledged write: the plan commit path. Ordinary marks coalesce and
 * log failures; a commit reports whether its document reached disk.
 */
export interface DurableCommitRequest {
  /** Built at write time from the latest session content plus the candidate. */
  snapshot(): DurableAgentSessionDocument;
  /** Whether a document read back from disk contains this commit. */
  verify(document: DurableAgentSessionDocument): boolean;
  /**
   * Asked once, immediately before the write starts, after any earlier write
   * for the session has finished. False withdraws the commit unwritten.
   */
  proceed?(): boolean;
  /**
   * Called once, synchronously, when the outcome becomes known: before any
   * later write takes its snapshot, so a committed candidate is published
   * before an ordinary write can observe the old state.
   */
  settle(committed: boolean): void;
}

/**
 * `unknown`: the rename failed and the file could not be read back. Later
 * writes for the session wait until reconciliation settles the request.
 * `withdrawn`: `proceed` refused the write before it started.
 */
export type DurableCommitOutcome = "committed" | "not_committed" | "unknown" | "removed" | "withdrawn";

/** The file operations a write and a reconciliation read use; injectable for fault tests. */
export interface DurableSessionFileSystem {
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

interface QueuedCommit {
  request: DurableCommitRequest;
  resolve(outcome: DurableCommitOutcome): void;
}

interface PendingWrite {
  snapshot: () => DurableAgentSessionDocument;
  dirty: boolean;
  removed: boolean;
  commits: QueuedCommit[];
  /** A commit whose rename failed and whose outcome is not yet known. */
  unresolved?: QueuedCommit & { reported: boolean };
  /** Reconciliation failed; wait for an explicit retry instead of spinning. */
  stalled: boolean;
  inFlight?: Promise<void>;
}

/**
 * One JSON document per agent session under `$STATE_DIR/sessions/`, so a
 * thread outlives the process that created it.
 *
 * Write-through rather than write-at-exit, because the backend can end without
 * warning (the parent-exit watchdog, a crash, a force quit). Each session has
 * its own file so one thread's per-delta churn never rewrites another's, and
 * writes follow `FileAuditLogStore`'s discipline: at most one write in flight
 * per session, later marks coalesce into one follow-up, the snapshot is taken
 * at write time so the file always reflects the newest state, temp-plus-rename
 * so a reader never sees a partial document, and a failed write is logged and
 * retried by the next mark rather than breaking the chain.
 *
 * The store knows nothing about what a session means. It holds no session
 * itself; the service that owns the in-memory record hands it a snapshot
 * function and tells it when a session is gone.
 *
 * `commit` shares the same per-session chain, so an acknowledged plan write
 * and ordinary marks are strictly ordered and no second writer exists.
 */
export class DurableAgentSessionStore {
  private readonly directory: string;
  private readonly pending = new Map<string, PendingWrite>();
  // Session ids are unique and never reused. Mark deletion before waiting for
  // an in-flight write so a late runner event cannot schedule a replacement
  // document while remove() yields, or after it returns.
  private readonly deletedSessionIds = new Set<string>();

  private readonly fileSystem: DurableSessionFileSystem;

  constructor(config: Pick<ServiceConfig, "stateDir">, deps: { fileSystem?: DurableSessionFileSystem } = {}) {
    this.directory = join(config.stateDir, DIRECTORY_NAME);
    this.fileSystem = deps.fileSystem ?? { writeFile, rename, readFile };
  }

  /**
   * Create the directory and read every document in it. Never throws for a
   * bad file: each one is counted, logged by path, and left where it is.
   */
  async initialize(): Promise<DurableAgentSessionInventory> {
    await this.ensureDirectory();
    const inventory: DurableAgentSessionInventory = { documents: [], migrated: 0, unsupported: 0, unreadable: 0 };
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const path = join(this.directory, name);
      const sessionId = name.slice(0, -FILE_SUFFIX.length);
      const outcome = await readDocument(this.fileSystem, path, sessionId);
      if (outcome.kind === "document") {
        inventory.documents.push(outcome.document);
        if (outcome.migrated) {
          inventory.migrated += 1;
          logger.info(
            { path, schemaVersion: outcome.fromSchemaVersion, migratedTo: DURABLE_AGENT_SESSION_SCHEMA_VERSION },
            "Agent session document migrated in memory; its next change rewrites it at this version"
          );
        }
      } else if (outcome.kind === "unsupported") {
        inventory.unsupported += 1;
        logger.warn(
          { path, schemaVersion: outcome.schemaVersion, supportedSchemaVersion: DURABLE_AGENT_SESSION_SCHEMA_VERSION },
          "Agent session document was written by a newer AgentRoom and is left untouched; update the app to read it"
        );
      } else {
        inventory.unreadable += 1;
        logger.warn({ path, reason: outcome.kind === "missing" ? "file vanished while reading" : outcome.reason }, "Agent session document is unreadable and is left in place");
      }
    }
    logger.info(
      {
        directory: this.directory,
        documents: inventory.documents.length,
        migrated: inventory.migrated,
        unsupported: inventory.unsupported,
        unreadable: inventory.unreadable
      },
      "Agent session documents read"
    );
    return inventory;
  }

  /**
   * Mark a session as changed. `snapshot` is called when the write actually
   * happens, so many marks during one write cost one `Map` update each and one
   * follow-up write in total. Resolves when this mark has reached disk (or its
   * write has failed and been logged).
   */
  schedule(sessionId: string, snapshot: () => DurableAgentSessionDocument): Promise<void> {
    assertSessionId(sessionId);
    if (this.deletedSessionIds.has(sessionId)) return Promise.resolve();
    const entry = this.entryFor(sessionId, snapshot);
    entry.snapshot = snapshot;
    entry.dirty = true;
    return this.kick(sessionId, entry);
  }

  /**
   * Write one acknowledged document through the session's chain. Resolves
   * with `committed` only after the rename succeeded (or a read-back after an
   * ambiguous rename found it), and never lets a failed candidate reach disk
   * through a later ordinary write: those snapshot the service's committed
   * state, not the candidate.
   */
  commit(sessionId: string, request: DurableCommitRequest): Promise<DurableCommitOutcome> {
    assertSessionId(sessionId);
    if (this.deletedSessionIds.has(sessionId)) return Promise.resolve("removed");
    // A commit never lends its candidate to ordinary writes; those always
    // snapshot through the service's own function, set by `schedule`.
    const entry = this.entryFor(sessionId, noOrdinarySnapshot);
    return new Promise((resolve) => {
      entry.commits.push({ request, resolve });
      entry.stalled = false;
      void this.kick(sessionId, entry);
    });
  }

  /** Whether a commit's outcome is still unknown for this session. */
  hasUnresolvedCommit(sessionId: string): boolean {
    return Boolean(this.pending.get(sessionId)?.unresolved);
  }

  /** Retry reading back an unresolved commit. Resolves true once it is settled. */
  async reconcile(sessionId: string): Promise<boolean> {
    const entry = this.pending.get(sessionId);
    if (!entry?.unresolved) return true;
    entry.stalled = false;
    await this.kick(sessionId, entry);
    return !entry.unresolved;
  }

  private entryFor(sessionId: string, snapshot: () => DurableAgentSessionDocument): PendingWrite {
    const existing = this.pending.get(sessionId);
    if (existing) return existing;
    const entry: PendingWrite = { snapshot, dirty: false, removed: false, commits: [], stalled: false };
    this.pending.set(sessionId, entry);
    return entry;
  }

  private kick(sessionId: string, entry: PendingWrite): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    entry.inFlight = this.drain(sessionId, entry).finally(() => {
      entry.inFlight = undefined;
      // A mark can land between the drain loop's last check and this cleanup;
      // re-kick so that state is not stranded in memory. A stalled
      // reconciliation waits for an explicit retry instead.
      const work = entry.dirty || entry.commits.length > 0 || entry.unresolved !== undefined;
      if (work && !entry.removed && !entry.stalled) {
        void this.kick(sessionId, entry);
      } else if (!work && this.pending.get(sessionId) === entry) {
        this.pending.delete(sessionId);
      }
    });
    return entry.inFlight;
  }

  /**
   * The session was deleted: drop any queued write and unlink the file. Waits
   * for an in-flight write first so a rename cannot land after the unlink and
   * resurrect a thread the person just deleted.
   */
  async remove(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    this.deletedSessionIds.add(sessionId);
    const entry = this.pending.get(sessionId);
    try {
      if (entry) {
        entry.dirty = false;
        entry.removed = true;
        for (const queued of entry.commits.splice(0)) queued.resolve("removed");
        await entry.inFlight;
        if (entry.unresolved) {
          if (!entry.unresolved.reported) entry.unresolved.resolve("removed");
          entry.unresolved = undefined;
        }
        if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
      }
      await rm(this.documentPath(sessionId), { force: true });
      await rm(this.documentPath(sessionId) + TEMP_SUFFIX, { force: true });
    } catch (error) {
      // The service still owns the session when deletion fails. Let its next
      // mutation retry persistence instead of leaving a live thread muted.
      this.deletedSessionIds.delete(sessionId);
      throw error;
    }
  }

  /** Wait for every queued write to reach disk. For shutdown and tests. */
  async flush(): Promise<void> {
    for (;;) {
      const inFlight = [...this.pending.values()].map((entry) => entry.inFlight).filter(Boolean);
      if (inFlight.length === 0) return;
      await Promise.all(inFlight);
    }
  }

  private async drain(sessionId: string, entry: PendingWrite): Promise<void> {
    while (!entry.removed && !entry.stalled && (entry.unresolved || entry.dirty || entry.commits.length > 0)) {
      if (entry.unresolved) {
        await this.reconcileEntry(sessionId, entry);
        continue;
      }
      const queued = entry.commits.shift();
      // Every snapshot is built from the latest content, so a write that
      // reaches disk, commit or ordinary, satisfies the pending mark. A commit
      // that never lands leaves the mark for an ordinary write.
      const marked = entry.dirty;
      entry.dirty = false;
      if (queued) {
        const committed = await this.writeCommit(sessionId, entry, queued);
        if (!committed && marked) entry.dirty = true;
        continue;
      }
      try {
        await this.writeDocument(sessionId, entry.snapshot());
      } catch (error) {
        logger.warn(
          { error, path: this.documentPath(sessionId) },
          "Agent session document write failed; the session remains in memory and the next change retries"
        );
      }
    }
  }

  /** True when the commit's document is on disk; false when it was withdrawn, failed, or is still unknown. */
  private async writeCommit(sessionId: string, entry: PendingWrite, queued: QueuedCommit): Promise<boolean> {
    const path = this.documentPath(sessionId);
    const tmp = path + TEMP_SUFFIX;
    if (queued.request.proceed && !queued.request.proceed()) {
      queued.request.settle(false);
      queued.resolve("withdrawn");
      return false;
    }
    try {
      await this.ensureDirectory();
      await this.fileSystem.writeFile(tmp, JSON.stringify(queued.request.snapshot()));
    } catch (error) {
      logger.warn({ error, path }, "Agent session commit failed before its rename; the previous document stands");
      queued.request.settle(false);
      queued.resolve("not_committed");
      return false;
    }
    try {
      await this.fileSystem.rename(tmp, path);
    } catch (error) {
      logger.warn({ error, path }, "Agent session commit rename failed; reading the document back to learn its outcome");
      entry.unresolved = { ...queued, reported: false };
      return false;
    }
    queued.request.settle(true);
    queued.resolve("committed");
    return true;
  }

  /**
   * Learn an ambiguous commit's outcome from the file itself. A readable
   * document settles it either way; a missing file means the rename never
   * happened. Anything else leaves it unresolved and stalls the chain, so no
   * later write can overwrite a document that may hold the commit.
   */
  private async reconcileEntry(sessionId: string, entry: PendingWrite): Promise<void> {
    const pending = entry.unresolved as NonNullable<PendingWrite["unresolved"]>;
    const outcome = await readDocument(this.fileSystem, this.documentPath(sessionId), sessionId);
    if (outcome.kind === "document" || outcome.kind === "missing") {
      const committed = outcome.kind === "document" && pending.request.verify(outcome.document);
      entry.unresolved = undefined;
      pending.request.settle(committed);
      if (!pending.reported) pending.resolve(committed ? "committed" : "not_committed");
      return;
    }
    logger.warn({ path: this.documentPath(sessionId) }, "Agent session commit outcome is still unknown; later writes wait");
    if (!pending.reported) {
      pending.reported = true;
      pending.resolve("unknown");
    }
    for (const queued of entry.commits.splice(0)) queued.resolve("unknown");
    entry.stalled = true;
  }

  private async writeDocument(sessionId: string, document: DurableAgentSessionDocument): Promise<void> {
    await this.ensureDirectory();
    const path = this.documentPath(sessionId);
    const tmp = path + TEMP_SUFFIX;
    await this.fileSystem.writeFile(tmp, JSON.stringify(document));
    await this.fileSystem.rename(tmp, path);
  }

  private async ensureDirectory(): Promise<void> {
    // The documents hold user and assistant text; the directory is private to
    // the operator, like the runners' own transcript directories.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private documentPath(sessionId: string): string {
    return join(this.directory, sessionId + FILE_SUFFIX);
  }
}

type ReadOutcome =
  | { kind: "document"; document: DurableAgentSessionDocument; migrated: boolean; fromSchemaVersion: number }
  | { kind: "missing" }
  | { kind: "unsupported"; schemaVersion: number }
  | { kind: "unreadable"; reason: string };

type DurableAgentSessionMigration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * One step per older schema version, keyed by the version it reads and
 * producing the next. A step migrates the document whole, never key by key
 * (the `settings.json` rule), and sets `schemaVersion` to the version it
 * produced.
 */
const MIGRATIONS: Readonly<Record<number, DurableAgentSessionMigration>> = {
  // v2 adds the thread plan and its mutation receipts beside the session.
  1: (document) => ({ ...document, schemaVersion: 2, plan: null, planMutationReceipts: [] })
};

/**
 * Bring a parsed document at an older known version up to this build's shape,
 * one step at a time, before validation. Returns `undefined` for a version no
 * step covers (below the table's floor, or not an integer), which the reader
 * reports as unreadable; a version newer than this build never reaches here.
 * A document already at this version passes through untouched.
 */
export function migrateDurableAgentSessionDocument(
  document: Record<string, unknown>
): { document: Record<string, unknown>; migrated: boolean } | undefined {
  let version = document.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version > DURABLE_AGENT_SESSION_SCHEMA_VERSION) {
    return undefined;
  }
  let current = document;
  let migrated = false;
  while (version < DURABLE_AGENT_SESSION_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return undefined;
    current = step(current);
    version += 1;
    migrated = true;
  }
  return { document: current, migrated };
}

async function readDocument(
  fileSystem: Pick<DurableSessionFileSystem, "readFile">,
  path: string,
  sessionId: string
): Promise<ReadOutcome> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: `read failed: ${describeError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "not JSON" };
  }
  const object = objectValue(parsed);
  if (!object) {
    return { kind: "unreadable", reason: "not a JSON object" };
  }
  const schemaVersion = object.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { kind: "unreadable", reason: "schemaVersion is not an integer" };
  }
  // Two distinct states with two distinct repairs: a newer file is repaired by
  // updating AgentRoom, an unreadable one by the operator deciding what to do
  // with it. Neither is rewritten or deleted here.
  if (schemaVersion > DURABLE_AGENT_SESSION_SCHEMA_VERSION) {
    return { kind: "unsupported", schemaVersion };
  }
  const migration = migrateDurableAgentSessionDocument(object);
  if (!migration) {
    return { kind: "unreadable", reason: `schemaVersion ${schemaVersion} has no migration path` };
  }
  const result = durableAgentSessionDocumentSchema.safeParse(migration.document);
  if (!result.success) {
    return { kind: "unreadable", reason: `schema: ${result.error.issues[0]?.message ?? "invalid"}` };
  }
  if (result.data.session.id !== sessionId) {
    // `remove` unlinks by session id; a document filed under another name
    // could never be deleted through the route, so it is not adopted.
    return { kind: "unreadable", reason: "file name does not match the session id inside" };
  }
  return { kind: "document", document: result.data, migrated: migration.migrated, fromSchemaVersion: schemaVersion };
}

function noOrdinarySnapshot(): DurableAgentSessionDocument {
  throw new Error("No ordinary snapshot was scheduled for this session");
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Agent session id is not a valid document name");
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
