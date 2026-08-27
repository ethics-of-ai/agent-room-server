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

interface PendingWrite {
  snapshot: () => DurableAgentSessionDocument;
  dirty: boolean;
  removed: boolean;
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
 */
export class DurableAgentSessionStore {
  private readonly directory: string;
  private readonly pending = new Map<string, PendingWrite>();
  // Session ids are unique and never reused. Mark deletion before waiting for
  // an in-flight write so a late runner event cannot schedule a replacement
  // document while remove() yields, or after it returns.
  private readonly deletedSessionIds = new Set<string>();

  constructor(config: Pick<ServiceConfig, "stateDir">) {
    this.directory = join(config.stateDir, DIRECTORY_NAME);
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
      const outcome = await readDocument(path, sessionId);
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
        logger.warn({ path, reason: outcome.reason }, "Agent session document is unreadable and is left in place");
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
    const entry = this.pending.get(sessionId) ?? { snapshot, dirty: false, removed: false };
    entry.snapshot = snapshot;
    entry.dirty = true;
    entry.removed = false;
    this.pending.set(sessionId, entry);
    if (entry.inFlight) return entry.inFlight;
    entry.inFlight = this.drain(sessionId, entry).finally(() => {
      entry.inFlight = undefined;
      // A mark can land between the drain loop's last dirty check and this
      // cleanup; re-schedule so that state is not stranded in memory.
      if (entry.dirty && !entry.removed) {
        void this.schedule(sessionId, entry.snapshot);
      } else if (this.pending.get(sessionId) === entry) {
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
        await entry.inFlight;
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
    while (entry.dirty && !entry.removed) {
      entry.dirty = false;
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

  private async writeDocument(sessionId: string, document: DurableAgentSessionDocument): Promise<void> {
    await this.ensureDirectory();
    const path = this.documentPath(sessionId);
    const tmp = path + TEMP_SUFFIX;
    await writeFile(tmp, JSON.stringify(document));
    await rename(tmp, path);
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
  | { kind: "unsupported"; schemaVersion: number }
  | { kind: "unreadable"; reason: string };

type DurableAgentSessionMigration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * One step per older schema version, keyed by the version it reads and
 * producing the next. Version 1 has no predecessor, so the table is empty; it
 * exists so the first real migration is a function to add here rather than a
 * reader to restructure. A step migrates the document whole, never key by key
 * — the `settings.json` rule — and sets `schemaVersion` to the version it
 * produced.
 */
const MIGRATIONS: Readonly<Record<number, DurableAgentSessionMigration>> = {};

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

async function readDocument(path: string, sessionId: string): Promise<ReadOutcome> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
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
