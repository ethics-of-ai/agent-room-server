import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceConfig } from "../domain/models";
import type { AgentRoomEvent } from "../events/eventTypes";
import { logger } from "../logging/logger";
import { redactSecrets } from "../util/redactSecrets";
import type { AuditLogEntry, AuditLogStore } from "./AuditLogStore";

const DEFAULT_MAX_AUDIT_ENTRIES = 500;
const MAX_TEXT_LENGTH = 500;
const DURABLE_EVENT_TYPES = new Set([
  "runner_audit",
  "agent_session_created",
  "agent_session_deleted",
  "agent_turn_started",
  "agent_turn_succeeded",
  "agent_turn_failed",
  "agent_turn_cancelled",
  "agent_permission_resolved",
  "agent_question_resolved",
  "workspace_registered",
  "workspace_removed",
  "workspace_branch_changed",
  "workspace_git_operation",
  "workspace_file_written",
  "config_reloaded",
  "editor_catalog_changed",
  "terminal_session_started",
  "terminal_session_closed"
]);

export interface FileAuditLogStoreOptions {
  maxEntries?: number;
}

export class FileAuditLogStore implements AuditLogStore {
  private readonly path: string;
  private readonly maxEntries: number;
  private entries: AuditLogEntry[] = [];
  private dirty = false;
  private writeInFlight: Promise<void> | undefined;

  constructor(config: ServiceConfig, options: FileAuditLogStoreOptions = {}) {
    this.path = join(config.stateDir, "audit-log.json");
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_AUDIT_ENTRIES;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.entries = Array.isArray(parsed) ? parsed.filter(isAuditLogEntry).slice(-this.maxEntries) : [];
    } catch {
      this.entries = [];
    }
  }

  attach(eventBus: { subscribe(handler: (event: AgentRoomEvent) => void): () => void }): () => void {
    return eventBus.subscribe((event) => {
      void this.append(event);
    });
  }

  async append(event: AgentRoomEvent): Promise<void> {
    // Filter synchronously: the bus delivers every event (including per-delta
    // stream events), and non-durable ones must not cost a closure and a
    // microtask on the write chain.
    const entry = toAuditLogEntry(event);
    if (!entry) return;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return this.scheduleWrite();
  }

  async flush(): Promise<void> {
    while (this.writeInFlight) {
      await this.writeInFlight;
    }
  }

  getRecent(limit = 100): AuditLogEntry[] {
    return this.entries.slice(-limit);
  }

  // Write-behind with collapsing: at most one write is in flight, and appends
  // that land during it coalesce into a single follow-up write instead of one
  // full-file rewrite per event. A failed write is logged and retried by the
  // next append rather than permanently breaking the chain.
  private scheduleWrite(): Promise<void> {
    this.dirty = true;
    if (this.writeInFlight) return this.writeInFlight;
    this.writeInFlight = this.drainWrites().finally(() => {
      this.writeInFlight = undefined;
      // An append can land between the drain loop's last dirty check and this
      // cleanup; re-schedule so that entry is not stranded in memory.
      if (this.dirty) void this.scheduleWrite();
    });
    return this.writeInFlight;
  }

  private async drainWrites(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.writeEntries();
      } catch (error) {
        logger.warn({ error, path: this.path }, "Audit log write failed; entries remain in memory");
      }
    }
  }

  private async writeEntries(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entries));
    await rename(tmp, this.path);
  }
}

function toAuditLogEntry(event: AgentRoomEvent): AuditLogEntry | null {
  if (!DURABLE_EVENT_TYPES.has(event.type)) return null;
  const payload = event.payload as Record<string, unknown> | undefined;
  const session = objectValue(payload?.session);
  const audit = payload?.audit;

  const entry: AuditLogEntry = {
    id: event.id,
    type: event.type,
    at: event.at
  };

  entry.sessionId = stringValue(payload?.sessionId ?? payload?.turnId ?? session?.id);
  entry.workspaceId = stringValue(payload?.workspaceId ?? session?.workspaceId);
  entry.workspacePath = stringValue(payload?.workspacePath ?? session?.workspacePath);
  entry.title = stringValue(session?.title);
  entry.state = stringValue(session?.status);
  assignText(entry, "message", payload?.message);
  assignText(entry, "error", payload?.error);
  if (audit !== undefined) {
    entry.audit = audit;
  }

  return entry;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assignText(entry: AuditLogEntry, key: "message" | "error", value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    entry[key] = redactText(value);
  }
}

function redactText(value: string): string {
  return redactSecrets(value).slice(0, MAX_TEXT_LENGTH);
}

function isAuditLogEntry(value: unknown): value is AuditLogEntry {
  const entry = objectValue(value);
  return typeof entry?.id === "string" && typeof entry.type === "string" && typeof entry.at === "string";
}
