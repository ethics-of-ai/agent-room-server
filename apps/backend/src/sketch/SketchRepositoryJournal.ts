import { mkdir, readFile, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sketchDigest } from "./SketchWorkspaceFiles";
import { SketchServiceError } from "./sketchErrors";
import {
  parseSketchState,
  SKETCH_LEGACY_SCHEMA_VERSION,
  SKETCH_SCHEMA_VERSION,
  SKETCH_V2_SCHEMA_VERSION,
  type SketchDocument,
  type SketchState
} from "./core";

const auxiliaryEnvelopeSchema = z.object({
  fileVersion: z.string(),
  history: z.unknown(),
  receipts: z.unknown(),
  expiredRequestIds: z.unknown().optional(),
  pending: z.object({
    beforeVersion: z.string().optional(),
    digest: z.string(),
    // Intended bytes are recovery evidence only; reads always use the workspace file.
    document: z.unknown(),
    history: z.unknown(),
    receipts: z.unknown(),
    expiredRequestIds: z.unknown()
  }).optional()
});
export interface SketchAuxiliary {
  fileVersion: string;
  history: SketchState["history"];
  receipts: SketchState["receipts"];
  expiredRequestIds: SketchState["expiredRequestIds"];
  pending?: {
    beforeVersion?: string;
    digest: string;
    document: SketchDocument;
    history: SketchState["history"];
    receipts: SketchState["receipts"];
    expiredRequestIds: SketchState["expiredRequestIds"];
  };
}

/** Durable intent precedes publication. Auxiliary data never supplies the current geometry. */
export class SketchRepositoryJournal {
  private readonly directory: string;
  constructor(stateDir: string) { this.directory = join(stateDir, "sketch-repository"); }

  async load(key: string): Promise<SketchAuxiliary | undefined> {
    const value = await this.raw(key);
    if (value === undefined) return undefined;
    const envelope = auxiliaryEnvelopeSchema.safeParse(value);
    if (!envelope.success) throw unreadableRecord();
    try {
      const current = normalizeStateParts(undefined, envelope.data.history, envelope.data.receipts, envelope.data.expiredRequestIds);
      const pending = envelope.data.pending === undefined ? undefined : (() => {
        const state = normalizeStateParts(
          envelope.data.pending.document,
          envelope.data.pending.history,
          envelope.data.pending.receipts,
          envelope.data.pending.expiredRequestIds
        );
        return {
          ...(envelope.data.pending.beforeVersion === undefined ? {} : { beforeVersion: envelope.data.pending.beforeVersion }),
          digest: envelope.data.pending.digest,
          document: state.document,
          history: state.history,
          receipts: state.receipts,
          expiredRequestIds: state.expiredRequestIds
        };
      })();
      return {
        fileVersion: envelope.data.fileVersion,
        history: current.history,
        receipts: current.receipts,
        expiredRequestIds: current.expiredRequestIds,
        ...(pending === undefined ? {} : { pending })
      };
    } catch {
      throw unreadableRecord();
    }
  }
  async save(key: string, value: SketchAuxiliary): Promise<void> { await this.write(key, value); }
  private async raw(key: string): Promise<unknown | undefined> {
    let serialized: string;
    try { serialized = await readFile(this.path(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try { return JSON.parse(serialized); }
    catch { throw unreadableRecord(); }
  }
  private async write(key: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); }
  }
  private path(key: string): string { return join(this.directory, `${sketchDigest(key)}.json`); }
}
export function auxiliary(state: SketchState, fileVersion: string): SketchAuxiliary {
  return { fileVersion, history: state.history, receipts: state.receipts, expiredRequestIds: state.expiredRequestIds };
}

function normalizeStateParts(
  document: unknown | undefined,
  history: unknown,
  receipts: unknown,
  expiredRequestIds: unknown
): SketchState {
  const documentRecord = isRecord(document) ? document : undefined;
  const rawVersion = documentRecord?.schemaVersion;
  const versions = typeof rawVersion === "number" ? [rawVersion] : [SKETCH_SCHEMA_VERSION, SKETCH_V2_SCHEMA_VERSION, SKETCH_LEGACY_SCHEMA_VERSION];
  for (const version of versions) {
    const sketchId = typeof documentRecord?.sketchId === "string" ? documentRecord.sketchId : "sketch-journal-migration";
    const candidateDocument = documentRecord ?? {
      schemaVersion: version,
      kind: "sketch",
      sketchId,
      revision: 0,
      objects: []
    };
    const candidate = {
      schemaVersion: version,
      sketchId,
      document: candidateDocument,
      history,
      receipts,
      ...(expiredRequestIds === undefined ? {} : { expiredRequestIds })
    };
    const parsed = parseSketchState(JSON.stringify(candidate));
    if (parsed.ok) return parsed.value;
  }
  throw unreadableRecord();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadableRecord(): SketchServiceError {
  return new SketchServiceError("Sketch recovery record is unreadable; no edits were applied", 409, "outcome_unknown");
}
