import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SketchWorkspaceFiles } from "../src/sketch/SketchWorkspaceFiles";
import { RepositorySketchService } from "../src/sketch/RepositorySketchService";
import { SketchRepositoryJournal, auxiliary } from "../src/sketch/SketchRepositoryJournal";
import { evaluateSketchCommit } from "../src/sketch/core";
import { EventBus } from "../src/events/EventBus";

// The service side of the relaxed revision rule: older file versions the
// service produced stay usable, history heads name their actor, and agent
// entries survive storage and recovery like human ones.

const box = (objectId: string) => ({ op: "create", objectId, kind: "box", size: [0.1, 0.1, 0.1] });
const resize = (objectId: string, edge: number) => ({ op: "update", objectId, kind: "box", size: [edge, edge, edge] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-sketch-concurrency-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const files = new SketchWorkspaceFiles({ findByIdWithoutGitRefresh: vi.fn(async () => ({ id: "workspace-a", path: workspace }) as never) });
  const journal = new SketchRepositoryJournal(join(root, "state"));
  const eventBus = new EventBus();
  const make = () => new RepositorySketchService({ files, journal, eventBus, invalidate: () => {} });
  const service = make();
  const sketch = await service.create("workspace-a", "Board");
  const seeded = await service.edit("workspace-a", sketch.path, "commit", {
    requestId: "seed", baseRevision: 0, fileVersion: sketch.fileVersion, operations: [box("a"), box("b")]
  });
  return { workspace, files, journal, make, service, path: sketch.path, seeded };
}

/**
 * Stands in for the agent commit path Stage 2 adds: evaluates an agent commit
 * against the stored state and saves it the way the service does.
 */
async function agentCommit(f: Awaited<ReturnType<typeof fixture>>, label: string, operations: unknown[]) {
  const target = await f.files.target("workspace-a");
  const file = await f.files.read(target, f.path);
  const key = `${target.workspaceRoot}\0${f.path}`;
  const stored = await f.journal.load(key);
  if (!stored) throw new Error("no stored history");
  const result = evaluateSketchCommit({
    schemaVersion: file.document.schemaVersion, sketchId: file.document.sketchId, document: file.document,
    history: stored.history, receipts: stored.receipts, expiredRequestIds: stored.expiredRequestIds,
    ...(stored.revisionLog ? { revisionLog: stored.revisionLog } : {})
  }, { requestId: `agent-${label.replace(/ /g, "-")}`, baseRevision: file.document.revision, actor: { kind: "agent", runnerId: "codex" },
    turnId: "turn-1", label, operations });
  if (!result.ok) throw new Error(result.error.message);
  const saved = await f.files.write(target, f.path, result.state.document, file.fileVersion);
  await f.journal.save(key, auxiliary(result.state, saved.fileVersion,
    [...(stored.fileVersions ?? []), { revision: result.state.document.revision, fileVersion: saved.fileVersion }]));
  return saved;
}

describe("repository sketch concurrency", () => {
  it("accepts a disjoint edit from an older file version this service produced", async () => {
    const f = await fixture();
    const other = await f.service.edit("workspace-a", f.path, "commit", {
      requestId: "other-window", baseRevision: 1, fileVersion: f.seeded.fileVersion, operations: [resize("a", 0.2)]
    });
    const stale = await f.make().edit("workspace-a", f.path, "commit", {
      requestId: "this-window", baseRevision: 1, fileVersion: f.seeded.fileVersion, operations: [resize("b", 0.3)]
    });
    expect([other.revision, stale.revision]).toEqual([2, 3]);
    await expect(f.service.edit("workspace-a", f.path, "commit", {
      requestId: "overlap", baseRevision: 1, fileVersion: f.seeded.fileVersion, operations: [resize("a", 0.4)]
    })).rejects.toMatchObject({ statusCode: 409, code: "stale_revision", details: { conflictingObjectIds: ["a"] } });
  });

  it("still refuses an older file version after an external write, even at a logged revision", async () => {
    const f = await fixture();
    const read = await f.service.read("workspace-a", f.path);
    await writeFile(join(f.workspace, f.path), JSON.stringify(read.document));
    const reread = await f.service.read("workspace-a", f.path);
    expect(reread.historyReset).toBe(true);
    const next = await f.service.edit("workspace-a", f.path, "commit", {
      requestId: "after-external", baseRevision: reread.revision, fileVersion: reread.fileVersion, operations: [resize("a", 0.2)]
    });
    expect(next.revision).toBe(2);
    // Revision 1 from before the external write names a version the service
    // never recorded after the reset.
    await expect(f.service.edit("workspace-a", f.path, "commit", {
      requestId: "pre-external", baseRevision: 1, fileVersion: f.seeded.fileVersion, operations: [resize("b", 0.3)]
    })).rejects.toMatchObject({ code: "file_changed" });
    // Revision 1 as re-read after the reset is fine.
    expect((await f.service.edit("workspace-a", f.path, "commit", {
      requestId: "post-external", baseRevision: 1, fileVersion: reread.fileVersion, operations: [resize("b", 0.3)]
    })).revision).toBe(3);
  });

  it("names the actor and label of the next undo and redo", async () => {
    const f = await fixture();
    const human = await f.service.read("workspace-a", f.path);
    expect(human.undoHead).toEqual({ label: "2 operation(s)", actorKind: "human" });
    expect(human.redoHead).toBeNull();
    await agentCommit(f, "align boxes", [resize("a", 0.2)]);
    const afterAgent = await f.service.read("workspace-a", f.path);
    expect(afterAgent.undoHead).toEqual({ label: "align boxes", actorKind: "agent" });
    // The person's undo reverses the agent's step and reports it as the redo head.
    const undone = await f.service.edit("workspace-a", f.path, "undo", {
      requestId: "person-undo", baseRevision: afterAgent.revision, fileVersion: afterAgent.fileVersion
    });
    expect(undone).toMatchObject({ undoHead: { actorKind: "human" }, redoHead: { label: "align boxes", actorKind: "agent" } });
    const read = await f.service.read("workspace-a", f.path);
    expect(read.document.objects.find((object) => object.id === "a")).toMatchObject({ size: [0.1, 0.1, 0.1] });
  });

  it("recovers an interrupted edit that follows an agent step with the agent entry and the log intact", async () => {
    const f = await fixture();
    const agentSaved = await agentCommit(f, "agent step", [resize("a", 0.2)]);
    const original = f.files.write.bind(f.files);
    vi.spyOn(f.files, "write").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("crash"); });
    const input = { requestId: "person", baseRevision: 2, fileVersion: agentSaved.fileVersion, operations: [resize("b", 0.3)] };
    await expect(f.service.edit("workspace-a", f.path, "commit", input)).rejects.toThrow("crash");
    vi.restoreAllMocks();
    const retried = await f.make().edit("workspace-a", f.path, "commit", input);
    expect(retried.revision).toBe(3);
    const read = await f.service.read("workspace-a", f.path);
    expect(read.undoDepth).toBe(3);
    expect(read.undoHead).toEqual({ label: "1 operation(s)", actorKind: "human" });
    // The recovered log and versions still let a stale disjoint edit through.
    const stale = await f.service.edit("workspace-a", f.path, "commit", {
      requestId: "stale-after-recovery", baseRevision: 2, fileVersion: agentSaved.fileVersion, operations: [box("c")]
    });
    expect(stale.revision).toBe(4);
  });

  it("orders rename and delete with edits on the same file, and never recreates a deleted file", async () => {
    const f = await fixture();
    const agent = { runnerId: "codex", sessionId: "session-1", turnId: "turn-1" };
    // An edit queued behind a rename lands first; the rename then moves its history.
    const current = await f.service.read("workspace-a", f.path);
    const edit = f.service.edit("workspace-a", f.path, "commit", { requestId: "before-rename", baseRevision: 1, fileVersion: f.seeded.fileVersion, operations: [resize("a", 0.2)] });
    const rename = f.service.rename("workspace-a", f.path, "renamed.sketch.json", current.fileVersion, agent);
    await expect(edit).resolves.toMatchObject({ revision: 2 });
    // The rename read its token before the edit landed, so it is refused unchanged.
    await expect(rename).rejects.toMatchObject({ code: "file_changed" });
    const fresh = await f.service.read("workspace-a", f.path);
    const renamed = await f.service.rename("workspace-a", f.path, "renamed.sketch.json", fresh.fileVersion, agent);
    expect(renamed).toMatchObject({ path: "renamed.sketch.json", revision: 2, undoDepth: 2, historyReset: false });
    await expect(f.service.edit("workspace-a", f.path, "commit", { requestId: "old-path", baseRevision: 2, fileVersion: fresh.fileVersion,
      operations: [resize("b", 0.3)] })).rejects.toMatchObject({ code: "file_missing" });

    // Delete refuses a stale token, then removes the file and its history for good.
    await expect(f.service.delete("workspace-a", "renamed.sketch.json", fresh.fileVersion, agent)).rejects.toMatchObject({ code: "file_changed" });
    await f.service.delete("workspace-a", "renamed.sketch.json", renamed.fileVersion, agent);
    expect(await readdir(f.workspace)).toEqual([]);
    // Retrying an earlier request after the delete finds nothing to recover into.
    await expect(f.make().edit("workspace-a", "renamed.sketch.json", "commit", { requestId: "before-rename", baseRevision: 1,
      fileVersion: f.seeded.fileVersion, operations: [resize("a", 0.2)] })).rejects.toMatchObject({ code: "file_missing" });
    expect(await readdir(f.workspace)).toEqual([]);
  });

  it("refuses to rename onto an occupied name or outside the workspace", async () => {
    const f = await fixture();
    const agent = { runnerId: "codex", sessionId: "session-1", turnId: "turn-1" };
    await f.service.create("workspace-a", "Taken");
    const current = await f.service.read("workspace-a", f.path);
    await expect(f.service.rename("workspace-a", f.path, "taken.sketch.json", current.fileVersion, agent)).rejects.toMatchObject({ code: "name_collision" });
    await expect(f.service.rename("workspace-a", f.path, "../escape.sketch.json", current.fileVersion, agent)).rejects.toThrow();
    await expect(f.service.rename("workspace-a", f.path, "missing-dir/x.sketch.json", current.fileVersion, agent)).rejects.toMatchObject({ code: "parent_missing" });
    expect((await readdir(f.workspace)).sort()).toEqual(["board.sketch.json", "taken.sketch.json"]);
  });
});
