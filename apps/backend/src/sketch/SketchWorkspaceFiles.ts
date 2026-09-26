import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";
import { hasHiddenPathSegment, tempEntrySuffix } from "../workspace/explorer/bounds";
import { resolveWritableParent } from "../workspace/explorer/entryMutation";
import { normalizeWorkspaceRelativePath, type WorkspaceTarget } from "../workspace/explorer/paths";
import { parseSketchDocument, serializeSketchDocument, SKETCH_MAX_DOCUMENT_BYTES, type SketchDocument } from "./core";
import { SketchServiceError } from "./sketchErrors";

export const sketchDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export interface SketchFile {
  document: SketchDocument;
  fileVersion: string;
  digest: string;
}

/** Only validated sketch documents can reach this writer. Generic text PUT keeps its own cap. */
export class SketchWorkspaceFiles {
  constructor(private readonly registry: Pick<LocalWorkspaceRegistry, "findByIdWithoutGitRefresh">) {}

  async target(workspaceId: string): Promise<WorkspaceTarget> {
    const workspace = await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) throw new SketchServiceError("Workspace is not registered", 404, "unknown_workspace");
    return { workspaceId, workspacePath: workspace.path, workspaceRoot: await realpath(workspace.path) };
  }

  async preferredPath(target: WorkspaceTarget, title: string): Promise<string> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "sketch";
    try {
      await this.leaf(target, `docs/sketches/${slug}.sketch.json`);
      return `docs/sketches/${slug}.sketch.json`;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404 && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      return `${slug}.sketch.json`;
    }
  }

  async exists(target: WorkspaceTarget, path: string): Promise<boolean> {
    try { await lstat(await this.leaf(target, path)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  async read(target: WorkspaceTarget, path: string): Promise<SketchFile> {
    const leaf = await this.leaf(target, path);
    let handle;
    try { handle = await open(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SketchServiceError("Sketch file is missing; locate it again", 409, "file_missing");
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new SketchServiceError("Sketch paths cannot contain symlinks", 415, "invalid_path");
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > SKETCH_MAX_DOCUMENT_BYTES) {
        throw new SketchServiceError("Sketch must be a regular file of at most 2 MiB", 413, "invalid_document");
      }
      const buffer = Buffer.alloc(SKETCH_MAX_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const after = await handle.stat();
      const current = await lstat(leaf);
      const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      if (identity(before) !== identity(after) || identity(after) !== identity(current)) throw changed();
      const parsed = parseSketchDocument(bytes.toString("utf8"));
      if (!parsed.ok) throw new SketchServiceError(parsed.error.message, 422, parsed.error.code);
      const digest = sketchDigest(bytes);
      return { document: parsed.value, digest, fileVersion: sketchDigest(`${identity(after)}:${digest}`) };
    } finally { await handle.close(); }
  }

  async write(target: WorkspaceTarget, path: string, document: SketchDocument, baseVersion?: string): Promise<SketchFile> {
    const content = repositorySketchBytes(document);
    const leaf = await this.leaf(target, path);
    if (baseVersion !== undefined && (await this.read(target, path)).fileVersion !== baseVersion) throw changed();
    const temporary = `${leaf}.${randomUUID()}${tempEntrySuffix}`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try {
      // Re-resolve the parent and compare identity immediately before publication.
      if (await this.leaf(target, path) !== leaf) throw changed();
      if (baseVersion !== undefined) {
        if ((await this.read(target, path)).fileVersion !== baseVersion) throw changed();
        await rename(temporary, leaf);
      } else {
        try { await link(temporary, leaf); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SketchServiceError("Sketch name was occupied during creation", 409, "file_exists"); throw error; }
      }
      const saved = await this.read(target, path);
      if (saved.digest !== sketchDigest(content)) throw changed();
      return saved;
    } finally { await rm(temporary, { force: true }); }
  }

  private async leaf(target: WorkspaceTarget, path: string): Promise<string> {
    const safe = normalizeWorkspaceRelativePath(path);
    if (!safe.endsWith(".sketch.json") || hasHiddenPathSegment(safe)) {
      throw new SketchServiceError("A visible workspace .sketch.json path is required", 415, "invalid_path");
    }
    // Do not let aliases give a document two serialization keys.
    let parent = target.workspaceRoot;
    for (const segment of safe.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      try {
        if ((await lstat(parent)).isSymbolicLink()) throw new SketchServiceError("Sketch paths cannot contain symlinks", 415, "invalid_path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SketchServiceError("Sketch parent is missing", 404, "parent_missing");
        throw error;
      }
    }
    const resolved = await resolveWritableParent(target.workspaceRoot, resolve(target.workspaceRoot, safe), "Sketch path is not writable");
    return join(resolved, basename(safe));
  }
}

export function repositorySketchBytes(document: SketchDocument): string {
  const bytes = JSON.stringify(JSON.parse(serializeSketchDocument(document)), null, 2) + "\n";
  const parsed = parseSketchDocument(bytes);
  if (!parsed.ok) throw new SketchServiceError(parsed.error.message, 422, parsed.error.code);
  return bytes;
}
export function changed(): SketchServiceError {
  return new SketchServiceError("Sketch file changed; reload before editing", 409, "file_changed");
}
