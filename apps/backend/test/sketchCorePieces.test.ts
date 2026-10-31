import { describe, expect, it } from "vitest";
import {
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  parseSketchState,
  redoSketchTransaction,
  serializeSketchDocument,
  serializeSketchState,
  undoSketchTransaction,
  type SketchCallerOperation,
  type SketchCoreError,
  type SketchObject,
  type SketchState,
  type SketchTransactionResult
} from "../src/sketch/core";

const human = { kind: "human", name: "Tester" } as const;
let counter = 0;

function commit(state: SketchState, operations: SketchCallerOperation[], baseRevision = state.document.revision): SketchTransactionResult {
  return evaluateSketchCommit(state, { requestId: `r${counter++}`, baseRevision, actor: human, operations });
}

function applied(result: SketchTransactionResult): SketchState {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}

function refused(result: SketchTransactionResult): SketchCoreError {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

function place(objectId: string, catalogId: string, cell: [number, number], extra: Record<string, unknown> = {}): SketchCallerOperation {
  return { op: "create", objectId, kind: "piece", catalogId, cell, ...extra } as SketchCallerOperation;
}

function piece(state: SketchState, id: string) {
  const object = state.document.objects.find((candidate) => candidate.id === id);
  if (object === undefined || object.kind !== "piece") throw new Error(`no piece ${id}`);
  return object as Extract<SketchObject, { kind: "piece" }>;
}

function byId(objects: SketchObject[]): SketchObject[] {
  return [...objects].sort((a, b) => a.id.localeCompare(b.id));
}

function v3Document(objects: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 3, kind: "sketch", sketchId: "legacy", revision: 4, ...extra, objects });
}

describe("sketch pieces", () => {
  // Landing and refusal cases live in fixtures/sketchPieceRuleCases.json,
  // which sketchPieceRuleCases.test.ts and the visionOS suite both run.

  it("gives a new piece no turn unless the create names one", () => {
    const state = applied(commit(createSketchState("stack"), [place("a", "block.cube", [0, 0])]));
    expect(piece(state, "a").rotation).toBe(0);
  });

  it("refuses catalog ids it does not know", () => {
    const error = refused(commit(createSketchState("unknown"), [place("tree", "block.tree", [0, 0])]));
    expect(error.code).toBe("unknown_piece");
  });

  it("lets only pieces whose entry carries text store it", () => {
    let state = createSketchState("labels");
    const onCube = refused(commit(state, [place("cube", "block.cube", [0, 0], { text: "Hi" })]));
    expect(onCube.code).toBe("invalid_operation");
    expect(onCube.message).toContain("block.label");
    state = applied(commit(state, [place("sign", "block.label", [0, 0], { text: "Main St" }), place("cube", "block.cube", [1, 0])]));
    expect(piece(state, "sign").text).toBe("Main St");
    expect(refused(commit(state, [{ op: "update", objectId: "cube", kind: "piece", text: "No" }])).code).toBe("invalid_operation");
    state = applied(commit(state, [{ op: "update", objectId: "sign", kind: "piece", text: null }]));
    expect(piece(state, "sign").text).toBeUndefined();
  });

  it("moves a piece onto another stack, drops the pieces above its old place, and undoes exactly", () => {
    let state = applied(commit(createSketchState("move"), [
      place("bottom", "block.cube", [0, 0]),
      place("middle", "block.cylinder", [0, 0]),
      place("top", "block.ramp", [0, 0]),
      place("base", "block.cube", [3, 0])
    ]));
    const before = structuredClone(state.document.objects);
    state = applied(commit(state, [{ op: "update", objectId: "middle", kind: "piece", cell: [3, 0], rotation: 2 }]));
    expect(piece(state, "middle")).toMatchObject({ cell: [3, 0], level: 1, rotation: 2 });
    expect(piece(state, "top").level).toBe(1);
    expect(piece(state, "bottom").level).toBe(0);

    state = applied(undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(state.document.objects).toEqual(before);
    state = applied(redoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(piece(state, "middle").cell).toEqual([3, 0]);
    expect(piece(state, "top").level).toBe(1);
  });

  it("drops the pieces above a deleted piece and restores them on undo", () => {
    let state = applied(commit(createSketchState("delete"), [
      place("a", "block.cube", [0, 0]),
      place("b", "block.cube", [0, 0]),
      place("c", "block.wall", [0, 0])
    ]));
    const before = structuredClone(state.document.objects);
    state = applied(commit(state, [{ op: "delete", objectId: "a" }]));
    expect([piece(state, "b").level, piece(state, "c").level]).toEqual([0, 1]);
    state = applied(undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(byId(state.document.objects)).toEqual(byId(before));
  });

  it("keeps pieces out of transforms and groups", () => {
    const state = applied(commit(createSketchState("grid-only"), [place("cube", "block.cube", [0, 0])]));
    const identity = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
    expect(refused(commit(state, [{ op: "transform", objectId: "cube", transform: structuredClone(identity) as never }])).code)
      .toBe("invalid_operation");
    expect(refused(commit(state, [{ op: "group", groupId: "g", memberIds: ["cube"] }])).code).toBe("invalid_operation");
  });

  it("sets the table's cell size and undoes back to no table", () => {
    let state = applied(commit(createSketchState("table"), [{ op: "setTable", cellSize: 0.08 }]));
    expect(state.document.table).toEqual({ cellSize: 0.08, cells: 10 });
    state = applied(undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(state.document.table).toBeUndefined();
    expect(refused(commit(state, [{ op: "setTable", cellSize: 0.5 }])).code).toBe("invalid_request");
  });

  it("keeps every piece on the table", () => {
    let state = applied(commit(createSketchState("bounded"), [place("edge", "block.cube", [15, 15])]));
    const off = refused(commit(state, [place("off", "block.cube", [16, 0])]));
    expect(off).toMatchObject({ code: "out_of_bounds", opIndex: 0 });
    expect(off.message).toContain("16 cells across: columns and rows run 0 to 15");
    expect(refused(commit(state, [{ op: "update", objectId: "edge", kind: "piece", cell: [0, 16] }])).code).toBe("out_of_bounds");
    expect(refused(commit(state, [place("negative", "block.cube", [-1, 0])])).code).toBe("invalid_request");
    state = applied(commit(state, [{ op: "setTable", cellSize: 0.02 }]));
    expect(state.document.table).toEqual({ cellSize: 0.02, cells: 40 });
    expect(applied(commit(state, [place("far", "block.cube", [39, 39])])).document.objects).toHaveLength(2);
  });

  it("refuses a cell size that would leave a piece off the table", () => {
    let state = applied(commit(createSketchState("shrink"), [place("a", "block.cube", [9, 2]), place("b", "block.cube", [12, 3])]));
    const shrink = refused(commit(state, [{ op: "setTable", cellSize: 0.08 }]));
    expect(shrink.code).toBe("out_of_bounds");
    expect(shrink.message).toContain('10 cells across, which leaves piece "b" at [12, 3] off it');
    state = applied(commit(state, [{ op: "delete", objectId: "b" }, { op: "setTable", cellSize: 0.08 }]));
    expect(state.document.table).toEqual({ cellSize: 0.08, cells: 10 });
    expect(refused(commit(state, [{ op: "setTable", cellSize: 0.2 }])).code).toBe("out_of_bounds");
  });

  it("undoes a cell size change back to the exact stored table", () => {
    const parsed = parseSketchState(serializeSketchState({
      ...createSketchState("narrow"),
      document: { ...createSketchState("narrow").document, table: { cellSize: 0.05, cells: 12 } }
    }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    let state = applied(commit(parsed.value, [{ op: "setTable", cellSize: 0.04 }]));
    expect(state.document.table).toEqual({ cellSize: 0.04, cells: 20 });
    state = applied(undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(state.document.table).toEqual({ cellSize: 0.05, cells: 12 });
    state = applied(redoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(state.document.table).toEqual({ cellSize: 0.04, cells: 20 });
  });

  it("clears pieces with everything else and restores them", () => {
    let state = applied(commit(createSketchState("clear"), [place("a", "block.cube", [0, 0]), place("b", "block.ramp", [0, 0])]));
    state = applied(commit(state, [{ op: "clear" }]));
    expect(state.document.objects).toEqual([]);
    state = applied(undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision: state.document.revision, actor: human }));
    expect(piece(state, "b").level).toBe(1);
  });

  it("serializes pieces and the table canonically and parses them back byte for byte", () => {
    const state = applied(commit(createSketchState("canonical"), [
      { op: "setTable", cellSize: 0.04 },
      place("sign", "block.label", [2, 5], { rotation: 3, color: "#C8553D", text: "Dock" })
    ]));
    const serialized = serializeSketchDocument(state.document);
    expect(serialized).toContain(
      '"revision":1,"table":{"cellSize":0.04,"cells":20},"objects":[{"id":"sign","kind":"piece","catalogId":"block.label","cell":[2,5],"level":0,"rotation":3,"color":"#C8553D","text":"Dock"}]'
    );
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok && serializeSketchDocument(parsed.value)).toBe(serialized);
    const stateParsed = parseSketchState(serializeSketchState(state));
    expect(stateParsed.ok).toBe(true);
  });

  it("refuses a stale create in a column a later revision changed, and applies one elsewhere", () => {
    const start = applied(commit(createSketchState("stale"), [place("seed", "block.cube", [9, 9])]));
    const base = start.document.revision;
    const later = applied(commit(start, [place("a", "block.cube", [0, 0])]));
    const sameColumn = refused(commit(later, [place("b", "block.cube", [0, 0])], base));
    expect(sameColumn.code).toBe("stale_revision");
    expect(sameColumn.conflictingObjectIds).toEqual(["a"]);
    const otherColumn = applied(commit(later, [place("c", "block.cube", [5, 5])], base));
    expect(piece(otherColumn, "c").level).toBe(0);
  });

  it("refuses a stale move, turn or delete when a later revision changed the piece's source or target column", () => {
    const start = applied(commit(createSketchState("stale-edits"), [
      place("x", "block.cube", [0, 0]),
      place("y", "block.cube", [3, 3])
    ]));
    const base = start.document.revision;
    const sourceChanged = applied(commit(start, [place("a", "block.cube", [0, 0])]));
    const targetChanged = applied(commit(start, [place("b", "block.cube", [3, 3])]));
    const elsewhere = applied(commit(start, [place("c", "block.cube", [7, 7])]));
    const edits: SketchCallerOperation[] = [
      { op: "update", objectId: "x", kind: "piece", cell: [5, 5] } as SketchCallerOperation,
      { op: "update", objectId: "x", kind: "piece", rotation: 1 } as SketchCallerOperation,
      { op: "delete", objectId: "x" }
    ];
    for (const edit of edits) {
      const source = refused(commit(sourceChanged, [edit], base));
      expect(source.code).toBe("stale_revision");
      expect(source.conflictingObjectIds).toEqual(["a"]);
      expect(commit(elsewhere, [edit], base).ok).toBe(true);
    }
    const target = refused(commit(targetChanged, [{ op: "update", objectId: "x", kind: "piece", cell: [3, 3] } as SketchCallerOperation], base));
    expect(target.code).toBe("stale_revision");
    expect(target.conflictingObjectIds).toEqual(["b"]);
  });
});

describe("reading pieces from files", () => {
  const file = (objects: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ schemaVersion: 4, kind: "sketch", sketchId: "file", revision: 1, ...extra, objects });
  const cube = (id: string, cell: [number, number], level: number) =>
    ({ id, kind: "piece", catalogId: "block.cube", cell, level, rotation: 0 });

  it("refuses floating pieces, pieces on non-stacking tops and text on non-labels", () => {
    for (const objects of [
      [cube("a", [0, 0], 1)],
      [{ ...cube("a", [0, 0], 0), catalogId: "block.ramp" }, cube("b", [0, 0], 1)],
      [{ ...cube("a", [0, 0], 0), text: "nope" }],
      [cube("a", [0, 0], 0), cube("b", [0, 0], 0)]
    ]) {
      const parsed = parseSketchDocument(file(objects));
      expect(parsed.ok ? "ok" : parsed.error.code).toBe("invalid_document");
    }
  });

  it("refuses a piece with a parent or a table out of range", () => {
    expect(parseSketchDocument(file([{ ...cube("a", [0, 0], 0), parentId: "g" }, { id: "g", kind: "group" }])).ok).toBe(false);
    expect(parseSketchDocument(file([], { table: { cellSize: 1, cells: 1 } })).ok).toBe(false);
    expect(parseSketchDocument(file([], { table: { cellSize: 0.05 } })).ok).toBe(false);
    expect(parseSketchDocument(file([], { table: { cellSize: 0.05, cells: 17 } })).ok).toBe(false);
    expect(parseSketchDocument(file([], { table: { cellSize: 0.05, cells: 12 } })).ok).toBe(true);
  });

  it("refuses a piece off its table", () => {
    const narrow = parseSketchDocument(file([cube("a", [12, 0], 0)], { table: { cellSize: 0.05, cells: 12 } }));
    expect(narrow.ok ? "ok" : narrow.error.message).toContain('Piece "a" at [12, 0] is off the table, which is 12 cells across');
    expect(parseSketchDocument(file([cube("a", [16, 0], 0)])).ok).toBe(false);
    expect(parseSketchDocument(file([cube("a", [15, 15], 0)])).ok).toBe(true);
  });

  it("keeps a piece whose catalog id this build lacks unchanged, and stacks nothing on it", () => {
    const parsed = parseSketchDocument(file([{ ...cube("tree", [0, 0], 0), catalogId: "block.tree", text: "Oak" }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const state = { ...createSketchState("file"), document: parsed.value };
    expect(refused(commit(state, [place("cube", "block.cube", [0, 0])])).code).toBe("piece_blocked");
    for (const change of [{ cell: [1, 1] }, { rotation: 1 }, { text: "Elm" }, { color: "#336633" }]) {
      expect(refused(commit(state, [{ op: "update", objectId: "tree", kind: "piece", ...change } as SketchCallerOperation])).code)
        .toBe("unknown_piece");
    }
    expect(applied(commit(state, [{ op: "delete", objectId: "tree" }])).document.objects).toEqual([]);
  });

  it("reads a version-3 file as version 4 without a table", () => {
    const parsed = parseSketchDocument(v3Document([{ id: "box", kind: "box", size: [0.1, 0.1, 0.1] }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(4);
    expect(parsed.value.table).toBeUndefined();
  });

  it("reads a version-3 opaque piece that matches version 4, and names one that does not", () => {
    const matching = parseSketchDocument(v3Document([cube("a", [0, 0], 0)]));
    expect(matching.ok && matching.value.objects[0].kind).toBe("piece");
    const broken = parseSketchDocument(v3Document([{ id: "odd", kind: "piece", shape: "tower" }]));
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error.code).toBe("invalid_document");
    expect(broken.error.message).toContain('"odd"');
  });

  it("refuses a version-3 file that already carries a table", () => {
    const parsed = parseSketchDocument(v3Document([], { table: { cellSize: 0.05 } }));
    expect(parsed.ok ? "ok" : parsed.error.code).toBe("invalid_document");
  });

  it("upgrades a version-3 state with its history", () => {
    let state = applied(commit(createSketchState("legacy"), [{ op: "create", objectId: "box", kind: "box", size: [0.1, 0.1, 0.1] }]));
    state = applied(commit(state, [{ op: "delete", objectId: "box" }]));
    const legacy = JSON.parse(serializeSketchState(state));
    legacy.schemaVersion = 3;
    legacy.document.schemaVersion = 3;
    const parsed = parseSketchState(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(4);
    expect(parsed.value.history.undo).toHaveLength(2);
  });

  it("refuses a newer version by name", () => {
    const parsed = parseSketchDocument(JSON.stringify({ schemaVersion: 5, kind: "sketch", sketchId: "next", revision: 0, objects: [] }));
    expect(parsed.ok ? "ok" : parsed.error.code).toBe("newer_document_version");
  });
});
