import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events/EventBus";
import { formatSketchList } from "../src/sketch/agent/sketchToolResults";
import { SKETCH_TOOL_RESULT_BYTES } from "../src/sketch/agent/sketchInspect";
import { createSketchState } from "../src/sketch/core";
import { SketchIndex, SKETCH_INDEX_SCAN_LIMIT } from "../src/sketch/index/SketchIndex";
import { SketchIndexStore } from "../src/sketch/index/SketchIndexStore";
import { sketchTitleFromPath } from "../src/sketch/index/sketchReference";
import { SketchRepositoryJournal } from "../src/sketch/SketchRepositoryJournal";
import { RepositorySketchService } from "../src/sketch/RepositorySketchService";
import { SketchWorkspaceFiles, repositorySketchBytes } from "../src/sketch/SketchWorkspaceFiles";
import { buildServer } from "../src/server";
import { config, registerWorkspaceOffline } from "./support/agentSessionHarness";

// Stage 3 of docs/plans/LIVE_AGENT_SKETCH_PLAN.md: the backend's stored list
// of sketches per workspace, kept current without a file watcher.

async function walk(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(root, full));
    else if (entry.isFile()) paths.push(relative(root, full));
  }
  return paths.sort();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sketch-index-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const stateDir = join(root, "state");
  const files = new SketchWorkspaceFiles({ findByIdWithoutGitRefresh: vi.fn(async () => ({ id: "ws", path: workspace }) as never) });
  const store = new SketchIndexStore(stateDir);
  const listPaths = vi.fn(async () => ({ paths: await walk(workspace), truncated: false }));
  const make = () => new SketchIndex({ store, files, listPaths });
  const index = make();
  const write = async (path: string, sketchId: string, objects = 0) => {
    const document = createSketchState(sketchId).document;
    document.objects = Array.from({ length: objects }, (_, i) => ({ id: `b${i}`, kind: "box", size: [0.1, 0.1, 0.1] })) as never;
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), repositorySketchBytes(document));
  };
  return { root, workspace, stateDir, files, store, listPaths, make, index, write };
}

describe("sketch index", () => {
  it("lists sketches with their identity and keeps invalid files visible", async () => {
    const f = await fixture();
    await f.write("docs/sketches/system-map.sketch.json", "sketch-map", 3);
    await f.write("board_one.sketch.json", "sketch-board");
    await writeFile(join(f.workspace, "broken.sketch.json"), "not json");
    await writeFile(join(f.workspace, "notes.md"), "# notes");
    const listed = await f.index.list("ws");
    expect(listed.total).toBe(3);
    expect(listed.entries.map((entry) => [entry.path, entry.title, entry.state, entry.sketchId, entry.objectCount])).toEqual([
      ["board_one.sketch.json", "board one", "ok", "sketch-board", 0],
      ["broken.sketch.json", "broken", "invalid", undefined, undefined],
      ["docs/sketches/system-map.sketch.json", "system map", "ok", "sketch-map", 3]
    ]);
    expect(listed.entries[1]?.invalidReason).toBe("invalid_document");
  });

  it("rebuilds from an empty or corrupt store and re-reads only changed files", async () => {
    const f = await fixture();
    await f.write("a.sketch.json", "sketch-a");
    await f.write("b.sketch.json", "sketch-b");
    const read = vi.spyOn(f.files, "read");
    expect((await f.index.list("ws")).entries).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
    await f.index.list("ws");
    expect(read).toHaveBeenCalledTimes(2);
    await f.write("b.sketch.json", "sketch-b", 1);
    await f.index.list("ws");
    expect(read).toHaveBeenCalledTimes(3);

    const files = await readdir(join(f.stateDir, "sketch-index"));
    expect(files).toHaveLength(1);
    await writeFile(join(f.stateDir, "sketch-index", files[0]!), "{ corrupt");
    const fresh = f.make();
    expect((await fresh.list("ws")).entries.map((entry) => entry.sketchId)).toEqual(["sketch-a", "sketch-b"]);
    await rm(join(f.stateDir, "sketch-index"), { recursive: true });
    expect((await f.make().list("ws")).entries).toHaveLength(2);
  });

  it("finds files added, renamed, and deleted outside AgentRoom on the next list, with no event", async () => {
    const f = await fixture();
    await f.write("first.sketch.json", "sketch-first");
    await f.write("second.sketch.json", "sketch-second");
    await f.index.list("ws");
    await f.write("third.sketch.json", "sketch-third");
    await rename(join(f.workspace, "first.sketch.json"), join(f.workspace, "renamed.sketch.json"));
    await rm(join(f.workspace, "second.sketch.json"));
    const listed = await f.index.list("ws");
    expect(listed.entries.map((entry) => [entry.path, entry.sketchId])).toEqual([
      ["renamed.sketch.json", "sketch-first"],
      ["third.sketch.json", "sketch-third"]
    ]);
    expect(listed.entries[0]?.lastActorKind).toBeUndefined();
  });

  it("stops at the scan bound and reports the total it saw", async () => {
    const f = await fixture();
    for (let i = 0; i < SKETCH_INDEX_SCAN_LIMIT + 5; i++) await f.write(`s/${String(i).padStart(3, "0")}.sketch.json`, `sketch-${i}`);
    const listed = await f.index.list("ws");
    expect(listed.entries).toHaveLength(SKETCH_INDEX_SCAN_LIMIT);
    expect(listed.total).toBe(SKETCH_INDEX_SCAN_LIMIT + 5);
    const text = formatSketchList(listed, undefined);
    expect(text).toContain(`The index holds ${SKETCH_INDEX_SCAN_LIMIT} of ${SKETCH_INDEX_SCAN_LIMIT + 5} sketch files`);
    // A filter cannot reach past the bound, so the hint names the exact path.
    const indexed = new Set(listed.entries.map((entry) => entry.path));
    const outside = [...Array(SKETCH_INDEX_SCAN_LIMIT + 5).keys()]
      .map((i) => `s/${String(i).padStart(3, "0")}.sketch.json`).find((path) => !indexed.has(path))!;
    expect(formatSketchList(listed, outside)).toMatch(/^ok: 0 sketch\(es\)/);
    expect(text).toContain("pass a sketch's exact path to reach the rest");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(SKETCH_TOOL_RESULT_BYTES);
    // A path beyond the bound is still reachable by name.
    const beyond = await f.index.resolve("ws", "s/204.sketch.json");
    expect(beyond).toMatchObject({ kind: "found", entry: { sketchId: "sketch-204" } });
  });

  it("keeps a list of long titles within 48 KiB", async () => {
    const f = await fixture();
    const long = "x".repeat(200);
    for (let i = 0; i < SKETCH_INDEX_SCAN_LIMIT; i++) await f.write(`${long}-${i}.sketch.json`, `sketch-${i}`);
    const text = formatSketchList(await f.index.list("ws"), undefined);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(SKETCH_TOOL_RESULT_BYTES);
    expect(text).toMatch(/more left out to stay within the result limit/);
    expect(formatSketchList(await f.index.list("ws"), "-199")).toContain(`${long}-199.sketch.json`);
  });

  it("resolves by path, id, and the title ladder, and says when a name is ambiguous", async () => {
    const f = await fixture();
    await f.write("docs/System Map.sketch.json", "sketch-map");
    await f.write("system-map.sketch.json", "sketch-map-2");
    await f.write("a/flow.sketch.json", "sketch-copy");
    await f.write("b/flow.sketch.json", "sketch-copy");
    await f.write("roadmap-2027.sketch.json", "sketch-roadmap");
    const resolve = (reference: string) => f.index.resolve("ws", reference);
    expect(await resolve("a/flow.sketch.json")).toMatchObject({ kind: "found", entry: { path: "a/flow.sketch.json" } });
    expect(await resolve("./a//flow.sketch.json")).toMatchObject({ kind: "found", entry: { path: "a/flow.sketch.json" } });
    expect(await resolve("sketch-roadmap")).toMatchObject({ kind: "found", entry: { path: "roadmap-2027.sketch.json" } });
    // A copied file shares its id, so the id is ambiguous and the path decides.
    expect(await resolve("sketch-copy")).toEqual({ kind: "ambiguous", paths: ["a/flow.sketch.json", "b/flow.sketch.json"] });
    // Exact title beats case-insensitive: "System Map" is one file, "system map" the other.
    expect(await resolve("System Map")).toMatchObject({ kind: "found", entry: { path: "docs/System Map.sketch.json" } });
    expect(await resolve("system map")).toMatchObject({ kind: "found", entry: { path: "system-map.sketch.json" } });
    expect(await resolve("SYSTEM MAP")).toEqual({ kind: "ambiguous", paths: ["docs/System Map.sketch.json", "system-map.sketch.json"] });
    expect(await resolve("Road")).toMatchObject({ kind: "found", entry: { path: "roadmap-2027.sketch.json" } });
    expect(await resolve("flow")).toEqual({ kind: "ambiguous", paths: ["a/flow.sketch.json", "b/flow.sketch.json"] });
    expect(await resolve("sytem mapp")).toMatchObject({ kind: "unknown", suggestions: expect.arrayContaining(["System Map", "system map"]) });
    expect(await resolve("../outside.sketch.json")).toMatchObject({ kind: "unknown" });
  });

  it("reads an exact path it has not indexed before answering unknown", async () => {
    const f = await fixture();
    await f.index.list("ws");
    await f.write("new.sketch.json", "sketch-new");
    expect(await f.index.resolve("ws", "new.sketch.json")).toMatchObject({ kind: "found", entry: { sketchId: "sketch-new" } });
    expect((await f.store.load("ws"))?.entries.map((entry) => entry.path)).toEqual(["new.sketch.json"]);
  });

  it("records service changes with their actor, follows events, and forgets a removed workspace", async () => {
    const f = await fixture();
    const bus = new EventBus();
    const service = new RepositorySketchService({ files: f.files, journal: new SketchRepositoryJournal(f.stateDir), eventBus: bus,
      invalidate: () => {}, changed: (change) => { void f.index.recordChange(change); } });
    const sessions = new Map([["session-1", "ws"]]);
    const stop = f.index.attach(bus, (id) => sessions.get(id));
    const created = await service.create("ws", "Plan");
    await service.editAsAgent("ws", created.path, "commit", { requestId: "a1", baseRevision: 0, fileVersion: created.fileVersion,
      label: "add", operations: [{ op: "create", objectId: "b", kind: "box", size: [0.1, 0.1, 0.1] }] },
      { runnerId: "codex", sessionId: "session-1", turnId: "turn-1" });
    await f.index.list("ws");
    const listed = await f.index.list("ws");
    expect(listed.entries).toEqual([expect.objectContaining({ path: "plan.sketch.json", revision: 1, objectCount: 1, lastActorKind: "agent" })]);

    // A raw write an agent made shows up through the settled turn's diff.
    f.listPaths.mockClear();
    await f.write("plan.sketch.json", created.sketchId, 4);
    bus.publish("coding_diff_updated", { sessionId: "session-1", turnId: "turn-1", files: [{ path: "plan.sketch.json", status: "modified" }] });
    await vi.waitFor(async () => expect((await f.store.load("ws"))?.entries[0]?.objectCount).toBe(4));
    expect(f.listPaths).not.toHaveBeenCalled();
    expect((await f.store.load("ws"))?.entries[0]?.lastActorKind).toBeUndefined();

    // A file-route event naming a sketch marks the workspace for a rescan on its next lookup.
    await f.write("other.sketch.json", "sketch-other");
    bus.publish("workspace_file_written", { workspaceId: "ws", path: "other.sketch.json" });
    expect(await f.index.resolve("ws", "sketch-other")).toMatchObject({ kind: "found" });
    expect(f.listPaths).toHaveBeenCalledTimes(1);

    bus.publish("workspace_removed", { workspaceId: "ws", path: f.workspace });
    await vi.waitFor(async () => expect(await f.store.load("ws")).toBeUndefined());
    expect((await readdir(f.workspace)).sort()).toEqual(["other.sketch.json", "plan.sketch.json"]);
    stop();
  });

  it("titles a sketch from its file name only", () => {
    expect(sketchTitleFromPath("docs/sketches/data_flow--v2.sketch.json")).toBe("data flow v2");
  });
});

describe("sketch list route", () => {
  it("serves the workspace's sketches behind bearer auth and advertises the index", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "index-token" });
    const workspace = await registerWorkspaceOffline(serviceConfig);
    await writeFile(join(workspace.path, "drawn.sketch.json"), repositorySketchBytes(createSketchState("sketch-drawn").document));
    const server = await buildServer({ config: serviceConfig, runners: {} });
    try {
      const headers = { authorization: "Bearer index-token" };
      expect((await server.app.inject({ method: "GET", url: "/api/config", headers })).json().sketchIndex).toBe(true);
      const url = `/api/workspaces/${workspace.id}/sketches`;
      expect((await server.app.inject({ method: "GET", url })).statusCode).toBe(401);
      const listed = await server.app.inject({ method: "GET", url, headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ sketches: [expect.objectContaining({ path: "drawn.sketch.json", title: "drawn", sketchId: "sketch-drawn", revision: 0, state: "ok" })], total: 1, truncated: false, limit: 200 });
      expect(listed.json().sketches[0]).not.toHaveProperty("stat");
      expect((await server.app.inject({ method: "GET", url: "/api/workspaces/workspace-missing/sketches", headers })).statusCode).toBe(404);
    } finally {
      await server.app.close();
    }
  });
});
