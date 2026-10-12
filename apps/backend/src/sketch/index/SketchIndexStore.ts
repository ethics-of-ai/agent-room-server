import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sketchDigest } from "../SketchWorkspaceFiles";

/**
 * One JSON file per registered workspace at
 * `STATE_DIR/sketch-index/<sha256 of workspace id>.json`. The index holds no
 * geometry and loses nothing a scan cannot rebuild, so a missing, corrupt, or
 * newer-schema file reads as empty and the next scan refills it.
 */

export const SKETCH_INDEX_SCHEMA_VERSION = 1;

const statSchema = z.object({ size: z.number(), mtimeMs: z.number(), ino: z.number() }).strict();

export const sketchIndexEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  title: z.string().max(512),
  state: z.enum(["ok", "invalid"]),
  sketchId: z.string().max(128).optional(),
  revision: z.number().int().min(0).optional(),
  objectCount: z.number().int().min(0).optional(),
  lastChangedAt: z.string().max(64).optional(),
  /** Absent when the last change came from outside AgentRoom's sketch routes and tools. */
  lastActorKind: z.enum(["human", "agent"]).optional(),
  /** The read error's code for an `invalid` entry. */
  invalidReason: z.string().max(64).optional(),
  stat: statSchema.optional(),
  /** The file version at `revision`, so a listed revision can be edited against. Backend-internal. */
  fileVersion: z.string().max(128).optional()
}).strict();

export type SketchIndexEntry = z.infer<typeof sketchIndexEntrySchema>;

const storedIndexSchema = z.object({
  schemaVersion: z.literal(SKETCH_INDEX_SCHEMA_VERSION),
  workspaceId: z.string(),
  entries: z.array(sketchIndexEntrySchema),
  /** Sketch files the last scan saw, which may exceed the entries it kept. */
  total: z.number().int().min(0),
  /** The workspace file index itself was truncated, so `total` is a floor. */
  truncated: z.boolean()
}).strict();

export type StoredSketchIndex = z.infer<typeof storedIndexSchema>;

export class SketchIndexStore {
  private readonly directory: string;
  constructor(stateDir: string) { this.directory = join(stateDir, "sketch-index"); }

  async load(workspaceId: string): Promise<StoredSketchIndex | undefined> {
    let serialized: string;
    try { serialized = await readFile(this.path(workspaceId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const parsed = storedIndexSchema.safeParse(JSON.parse(serialized));
      return parsed.success && parsed.data.workspaceId === workspaceId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async save(index: StoredSketchIndex): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(index.workspaceId);
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(index)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); }
  }

  async remove(workspaceId: string): Promise<void> {
    await rm(this.path(workspaceId), { force: true });
  }

  private path(workspaceId: string): string { return join(this.directory, `${sketchDigest(workspaceId)}.json`); }
}
