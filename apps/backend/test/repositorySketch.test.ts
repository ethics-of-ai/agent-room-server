import { mkdtemp, mkdir, readFile, writeFile, symlink, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SketchWorkspaceFiles, repositorySketchBytes } from "../src/sketch/SketchWorkspaceFiles";
import { RepositorySketchService } from "../src/sketch/RepositorySketchService";
import { SketchRepositoryJournal } from "../src/sketch/SketchRepositoryJournal";
import { SKETCH_SCHEMA_VERSION, createSketchState, documentWithUnknownObject } from "../src/sketch/core";
import { EventBus } from "../src/events/EventBus";

const box = (objectId: string) => ({ op: "create", objectId, kind: "box", size: [0.1, 0.1, 0.1] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-sketch-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const stateDir = join(root, "state");
  const files = new SketchWorkspaceFiles({ findByIdWithoutGitRefresh: vi.fn(async () => ({ id: "workspace-a", path: workspace }) as never) });
  const journal = new SketchRepositoryJournal(stateDir);
  const eventBus = new EventBus();
  const make = () => new RepositorySketchService({ files, journal, eventBus, invalidate: () => {} });
  return { root, workspace, stateDir, files, journal, eventBus, make, service: make() };
}

describe("repository sketches", () => {
  it("saves only the document, supports undo and standalone reopening without backend state", async () => {
    const f = await fixture();
    const sketch = await f.service.create("workspace-a", "My drawing");
    const input = { requestId: "draw-1", baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box("b")] };
    const result = await f.service.edit("workspace-a", sketch.path, "commit", input);
    expect(await f.make().edit("workspace-a", sketch.path, "commit", input)).toEqual(result);
    const raw = await readFile(join(f.workspace, sketch.path), "utf8");
    expect(Object.keys(JSON.parse(raw))).toEqual(["schemaVersion", "kind", "sketchId", "revision", "objects"]);
    expect(raw).toContain('\n  "schemaVersion"');
    const undo = await f.service.edit("workspace-a", sketch.path, "undo", { requestId: "undo-1", baseRevision: 1, fileVersion: result.fileVersion });
    expect(undo.revision).toBe(2);
    const redo = await f.service.edit("workspace-a", sketch.path, "redo", { requestId: "redo-1", baseRevision: 2, fileVersion: undo.fileVersion });
    expect(redo.revision).toBe(3);
    const fresh = new RepositorySketchService({ files: f.files, journal: new SketchRepositoryJournal(join(f.root, "fresh")), eventBus: f.eventBus,
      invalidate: () => {} });
    expect((await fresh.read("workspace-a", sketch.path)).document.objects).toHaveLength(1);
    const events = JSON.stringify(f.eventBus.getRecentEvents());
    expect(events).not.toContain('"operations"');
    expect(events).not.toContain('"objects"');
    expect(events).not.toContain('"fileVersion"');
  });

  it("reads v1 repository files without rewriting and preserves undo through the first current-version edit", async () => {
    const f = await fixture();
    const sketch = await f.service.create("workspace-a", "My drawing");
    const created = await f.service.edit("workspace-a", sketch.path, "commit", {
      requestId: "create-stroke",
      baseRevision: 0,
      fileVersion: sketch.fileVersion,
      operations: [{
        op: "create",
        objectId: "stroke-1",
        kind: "stroke",
        points: [[-0.5, 0, 0], [0.5, 0, 0]],
        width: 0.008
      }]
    });
    const deleted = await f.service.edit("workspace-a", sketch.path, "commit", {
      requestId: "delete-stroke",
      baseRevision: 1,
      fileVersion: created.fileVersion,
      operations: [{ op: "delete", objectId: "stroke-1" }]
    });

    const target = await f.files.target("workspace-a");
    const key = `${target.workspaceRoot}\0${sketch.path}`;
    const storedHistory = await f.journal.load(key);
    if (!storedHistory) throw new Error("repository history was not stored");
    const legacyHistory = structuredClone(storedHistory) as any;
    const stripStyle = (object: Record<string, unknown>) => {
      if (object.kind === "stroke") {
        delete object.brush;
        delete object.lineStyle;
      }
    };
    for (const entry of [...legacyHistory.history.undo, ...legacyHistory.history.redo]) {
      for (const operation of [...entry.forwardOps, ...entry.inverseOps]) {
        if (operation.op === "create" && operation.kind === "stroke") {
          delete operation.brush;
          delete operation.lineStyle;
        }
        if (operation.op === "restore") for (const object of operation.objects) stripStyle(object);
      }
    }

    const current = await f.files.read(target, sketch.path);
    const legacyDocument = structuredClone(current.document) as any;
    legacyDocument.schemaVersion = 1;
    for (const object of legacyDocument.objects) stripStyle(object);
    const legacyBytes = `${JSON.stringify(legacyDocument, null, 2)}\n`;
    await writeFile(join(f.workspace, sketch.path), legacyBytes);
    legacyHistory.fileVersion = (await f.files.read(target, sketch.path)).fileVersion;
    await f.journal.save(key, legacyHistory);

    const read = await f.service.read("workspace-a", sketch.path);
    expect(read.document.schemaVersion).toBe(SKETCH_SCHEMA_VERSION);
    expect(read.document.revision).toBe(2);
    expect(read.undoDepth).toBe(2);
    expect(await readFile(join(f.workspace, sketch.path), "utf8")).toBe(legacyBytes);

    const undone = await f.service.edit("workspace-a", sketch.path, "undo", {
      requestId: "undo-v1-delete",
      baseRevision: read.revision,
      fileVersion: read.fileVersion
    });
    expect(undone.revision).toBe(3);
    const rewritten = JSON.parse(await readFile(join(f.workspace, sketch.path), "utf8"));
    expect(rewritten.schemaVersion).toBe(SKETCH_SCHEMA_VERSION);
    expect(rewritten.objects.find((object: { id: string }) => object.id === "stroke-1")).toMatchObject({
      brush: "finePen",
      lineStyle: "solid"
    });
    expect(deleted.revision).toBe(2);
  });

  it("serializes competing windows and detects external edits that reuse a revision", async () => {
    const f = await fixture();
    const sketch = await f.service.create("workspace-a", "My drawing");
    const results = await Promise.allSettled(["a", "b"].map((id) => f.service.edit("workspace-a", sketch.path, "commit", {
      requestId: id, baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box(id)]
    })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const before = await f.service.read("workspace-a", sketch.path);
    await writeFile(join(f.workspace, sketch.path), JSON.stringify(before.document));
    const after = await f.service.read("workspace-a", sketch.path);
    expect(after.revision).toBe(before.revision);
    expect(after.historyReset).toBe(true);
    expect(after.undoDepth).toBe(0);
    await expect(f.service.edit("workspace-a", sketch.path, "commit", { requestId: "c", baseRevision: before.revision,
      fileVersion: before.fileVersion, operations: [box("c")] })).rejects.toMatchObject({ code: "file_changed" });
  });

  it.each(["before publication", "after publication", "receipt persistence"])("recovers a crash at %s without repeating a gesture", async (point) => {
    const f = await fixture();
    const sketch = await f.service.create("workspace-a", "My drawing");
    const input = { requestId: "gesture", baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box("b")] };
    const original = f.files.write.bind(f.files);
    if (point === "before publication") vi.spyOn(f.files, "write").mockRejectedValueOnce(new Error("crash"));
    if (point === "after publication") vi.spyOn(f.files, "write").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("crash"); });
    if (point === "receipt persistence") {
      const save = f.journal.save.bind(f.journal);
      vi.spyOn(f.journal, "save").mockImplementationOnce(save).mockRejectedValueOnce(new Error("crash"));
    }
    await expect(f.service.edit("workspace-a", sketch.path, "commit", input)).rejects.toThrow("crash");
    vi.restoreAllMocks();
    expect((await f.make().edit("workspace-a", sketch.path, "commit", input)).revision).toBe(1);
    expect((await f.service.read("workspace-a", sketch.path)).document.objects).toHaveLength(1);
  });

  it("refuses ambiguous recovery when an external writer intervenes after publication", async () => {
    const f = await fixture();
    const sketch = await f.service.create("workspace-a", "My drawing");
    const write = f.files.write.bind(f.files);
    vi.spyOn(f.files, "write").mockImplementationOnce(async (...args) => {
      await write(...args);
      await writeFile(join(f.workspace, sketch.path), repositorySketchBytes(createSketchState("different").document));
      throw new Error("crash");
    });
    const input = { requestId: "gesture", baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box("b")] };
    await expect(f.service.edit("workspace-a", sketch.path, "commit", input)).rejects.toThrow("crash");
    await expect(f.make().edit("workspace-a", sketch.path, "commit", input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(JSON.parse(await readFile(join(f.workspace, sketch.path), "utf8")).sketchId).toBe("different");
    const inspected = await f.service.read("workspace-a", sketch.path);
    expect(inspected.outcomeUnknown).toBe(true);
    await expect(f.service.resetHistory("workspace-a", sketch.path, sketch.fileVersion)).rejects.toMatchObject({ code: "file_changed" });
    const reset = await f.service.resetHistory("workspace-a", sketch.path, inspected.fileVersion);
    expect(reset.document).toEqual(inspected.document);
    expect(reset.outcomeUnknown).toBe(false);
    expect((await f.service.edit("workspace-a", sketch.path, "commit", {
      requestId: "after-inspection", baseRevision: reset.revision, fileVersion: reset.fileVersion, operations: [box("fresh")]
    })).revision).toBe(1);
  });

  it("creates a new sketch under the name a deleted file freed", async () => {
    const f = await fixture();
    const first = await f.service.create("workspace-a", "My drawing");
    await rm(join(f.workspace, first.path));
    await expect(f.service.read("workspace-a", first.path)).rejects.toMatchObject({ code: "file_missing" });
    const fresh = await f.make().create("workspace-a", "My drawing");
    expect(fresh.path).toBe("my-drawing.sketch.json");
    expect(fresh.sketchId).not.toBe(first.sketchId);
    expect(fresh.document.objects).toEqual([]);
  });

  it("prefers an existing docs/sketches directory and refuses after five occupied names", async () => {
    const f = await fixture();
    await mkdir(join(f.workspace, "docs/sketches"), { recursive: true });
    for (let i = 1; i <= 5; i++) await writeFile(join(f.workspace, `docs/sketches/my-drawing${i === 1 ? "" : `-${i}`}.sketch.json`), "occupied");
    await expect(f.service.create("workspace-a", "My drawing")).rejects.toMatchObject({ code: "name_collision" });
    const sketch = await f.service.create("workspace-a", "Other");
    expect(sketch.path).toBe("docs/sketches/other.sketch.json");
  });

  it("moves past a create-only collision without clobbering the other writer", async () => {
    const f = await fixture();
    const write = f.files.write.bind(f.files);
    vi.spyOn(f.files, "write").mockImplementationOnce(async (target, path, document, token) => {
      await writeFile(join(f.workspace, path), "another writer");
      return write(target, path, document, token);
    });
    const saved = await f.service.create("workspace-a", "My drawing");
    expect(saved.path).toBe("my-drawing-2.sketch.json");
    expect(await readFile(join(f.workspace, "my-drawing.sketch.json"), "utf8")).toBe("another writer");
  });

  it("rejects symlinks, traversal, secret paths, invalid JSON and newer versions without writes", async () => {
    const f = await fixture();
    const target = await f.files.target("workspace-a");
    const doc = createSketchState("safe").document;
    await writeFile(join(f.root, "outside.sketch.json"), repositorySketchBytes(doc));
    await symlink(join(f.root, "outside.sketch.json"), join(f.workspace, "link.sketch.json"));
    await symlink(f.root, join(f.workspace, "alias"));
    for (const path of ["../outside.sketch.json", ".env.sketch.json", "alias/outside.sketch.json", "plain.json"]) {
      await expect(f.files.write(target, path, doc)).rejects.toThrow();
    }
    await expect(f.files.read(target, "link.sketch.json")).rejects.toThrow();
    for (const content of ["invalid", JSON.stringify({ ...doc, schemaVersion: 99 })]) {
      await writeFile(join(f.workspace, "bad.sketch.json"), content);
      await expect(f.service.read("workspace-a", "bad.sketch.json")).rejects.toThrow();
      expect(await readFile(join(f.workspace, "bad.sketch.json"), "utf8")).toBe(content);
    }
    expect(await readFile(join(f.root, "outside.sketch.json"), "utf8")).toBe(repositorySketchBytes(doc));
  });

  it("enforces formatted 2 MiB size and leaves missing targets missing", async () => {
    const f = await fixture();
    const target = await f.files.target("workspace-a");
    const doc = createSketchState("large").document;
    doc.objects = [{ id: "unknown", kind: "future", payload: Array(250_000).fill(0) }];
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(2 * 1024 * 1024);
    await expect(f.files.write(target, "large.sketch.json", doc)).rejects.toMatchObject({ code: "invalid_document" });
    await expect(f.files.write(target, "gone.sketch.json", createSketchState("small").document, "old-token")).rejects.toMatchObject({ code: "file_missing" });
    expect(await readdir(f.workspace)).toEqual([]);
  });

  it("serializes edits per file, not per workspace", async () => {
    const f = await fixture();
    const target = await f.files.target("workspace-a");
    await f.files.write(target, "first.sketch.json", createSketchState("first").document);
    await f.files.write(target, "second.sketch.json", createSketchState("second").document);
    const first = await f.service.read("workspace-a", "first.sketch.json");
    const second = await f.service.read("workspace-a", "second.sketch.json");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const write = f.files.write.bind(f.files);
    vi.spyOn(f.files, "write").mockImplementation(async (...args) => {
      if (args[1] === "first.sketch.json") await held;
      return write(...args);
    });
    const edit = (path: string, fileVersion: string, requestId: string) =>
      f.service.edit("workspace-a", path, "commit", { requestId, baseRevision: 0, fileVersion, operations: [box("b")] });
    const blocked = edit("first.sketch.json", first.fileVersion, "first-edit");
    const queued = f.service.read("workspace-a", "first.sketch.json");
    let queuedSettled = false;
    void queued.then(() => { queuedSettled = true; });
    expect((await edit("second.sketch.json", second.fileVersion, "second-edit")).revision).toBe(1);
    expect(queuedSettled).toBe(false);
    release();
    expect((await blocked).revision).toBe(1);
    expect((await queued).revision).toBe(1);
  });

  it("opens a copied repository document with a fresh workspace identity", async () => {
    const source = await fixture();
    const sketch = await source.service.create("workspace-a", "My drawing");
    const clone = await fixture();
    await copyFile(join(source.workspace, sketch.path), join(clone.workspace, sketch.path));
    expect((await clone.service.read("another-registration", sketch.path)).document).toEqual(sketch.document);
  });
});
