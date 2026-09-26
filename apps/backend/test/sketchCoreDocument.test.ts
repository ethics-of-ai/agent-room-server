import { describe, expect, it } from "vitest";
import {
  SKETCH_SCHEMA_VERSION,
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  parseSketchState,
  serializeSketchDocument,
  serializeSketchState,
  undoSketchTransaction,
  type SketchState
} from "../src/sketch/core";
import {
  FIXTURE_SKETCH_ID,
  documentWithUnknownObject,
  nonPlanarSketchCreateOperations,
  nonPlanarSketchDocument
} from "../src/sketch/core/fixtures";

// Storage and wire behavior: canonical round trips, the unknown-kind and
// newer-version compatibility rules, structural rejection of corrupt
// documents, and state-level durability (history and receipts survive a
// serialize/parse cycle and remain usable).

const human = { kind: "human", name: "Tester" } as const;

function commitFromFixture(): SketchState {
  const state = createSketchState(FIXTURE_SKETCH_ID);
  const result = evaluateSketchCommit(state, {
    requestId: "fixture-seed",
    baseRevision: 0,
    actor: human,
    operations: nonPlanarSketchCreateOperations()
  });
  expect(result.ok).toBe(true);
  return result.ok ? result.state : state;
}

describe("sketch document round trips", () => {
  it("round trips the non-planar fixture through serialize and parse", () => {
    const document = nonPlanarSketchDocument();
    const serialized = serializeSketchDocument(document);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(document);
    // Canonical serialization is byte-stable across a round trip.
    expect(serializeSketchDocument(parsed.value)).toBe(serialized);
  });

  it("produces the fixture document from the fixture operations", () => {
    // Evaluating the canonical creation flow yields the same objects the
    // hand-written fixture describes — the two cannot drift apart silently.
    const state = commitFromFixture();
    const expected = nonPlanarSketchDocument(1);
    expect(state.document.objects).toHaveLength(expected.objects.length);
    for (const object of expected.objects) {
      const actual = state.document.objects.find((candidate) => candidate.id === object.id);
      expect(actual).toEqual(object);
    }
  });

  it("preserves unknown-kind objects and their fields exactly", () => {
    const document = documentWithUnknownObject();
    const parsed = parseSketchDocument(serializeSketchDocument(document));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const unknown = parsed.value.objects.find((object) => object.id === "fixture-hexahedron");
    expect(unknown).toEqual(document.objects.at(-1));
    expect(unknown).toMatchObject({
      kind: "hexahedron",
      faces: 6,
      metadata: { source: "future-version" },
      parentId: "fixture-group"
    });
  });

  it("rejects malformed JSON and malformed known kinds without falling back to unknown", () => {
    const notJson = parseSketchDocument("{not json");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) {
      expect(notJson.error.code).toBe("invalid_document");
    }

    // A stroke with broken points must fail as a stroke, not survive as a
    // preserved unknown object.
    const brokenStroke = {
      ...nonPlanarSketchDocument(),
      objects: [{ id: "s", kind: "stroke", points: "nope", width: 0.1 }]
    };
    const parsed = parseSketchDocument(JSON.stringify(brokenStroke));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("invalid_document");
      expect(parsed.error.message).toContain("stroke");
    }
  });
});

describe("sketch document compatibility rules", () => {
  it("fails a newer document version explicitly with both versions named", () => {
    const newer = { ...nonPlanarSketchDocument(), schemaVersion: SKETCH_SCHEMA_VERSION + 1 };
    const parsed = parseSketchDocument(JSON.stringify(newer));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("newer_document_version");
      expect(parsed.error.supportedVersion).toBe(SKETCH_SCHEMA_VERSION);
      expect(parsed.error.foundVersion).toBe(SKETCH_SCHEMA_VERSION + 1);
      // Explicit failure, never a quiet reset to an empty sketch.
      expect(parsed.error.message).toContain(String(SKETCH_SCHEMA_VERSION));
    }
  });

  it("upgrades v1 strokes in memory with explicit default style and preserves unknown fields", () => {
    const current = documentWithUnknownObject();
    const v1 = {
      ...current,
      schemaVersion: 1,
      objects: current.objects.map((object) => {
        if (object.kind !== "stroke") return object;
        const { brush: _brush, lineStyle: _lineStyle, ...legacyStroke } = object;
        return legacyStroke;
      })
    };
    const originalBytes = JSON.stringify(v1);
    const parsed = parseSketchDocument(originalBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(SKETCH_SCHEMA_VERSION);
    expect(parsed.value.objects.find((object) => object.kind === "stroke")).toMatchObject({
      brush: "finePen",
      lineStyle: "solid"
    });
    expect(parsed.value.objects.at(-1)).toEqual(current.objects.at(-1));
    expect(JSON.stringify(v1)).toBe(originalBytes);
    expect(serializeSketchDocument(parsed.value)).not.toBe(originalBytes);
  });

  it("names a v1 unknown object whose kind version 2 now defines differently", () => {
    const v1 = {
      schemaVersion: 1,
      kind: "sketch",
      sketchId: FIXTURE_SKETCH_ID,
      revision: 3,
      objects: [{ id: "legacy-shape", kind: "planarShape", corners: 4 }]
    };
    const parsed = parseSketchDocument(JSON.stringify(v1));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("invalid_document");
    expect(parsed.error.message).toContain('"legacy-shape"');
    expect(parsed.error.message).toContain('"planarShape"');
  });

  it("reads a v1 object with a reclaimed kind when it already matches version 2", () => {
    const shape = {
      id: "legacy-shape",
      kind: "planarShape",
      shapeType: "rectangle",
      size: [0.1, 0.1],
      appearance: "fill",
      fillColor: "#112233",
      outlineColor: "#112233",
      outlineWidth: 0.004
    };
    const parsed = parseSketchDocument(JSON.stringify({
      schemaVersion: 1,
      kind: "sketch",
      sketchId: FIXTURE_SKETCH_ID,
      revision: 3,
      objects: [shape]
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.objects[0]).toEqual(shape);
  });

  it("rejects v2 stroke fields when a document claims to be v1", () => {
    const parsed = parseSketchDocument(JSON.stringify({
      ...nonPlanarSketchDocument(),
      schemaVersion: 1
    }));
    expect(parsed.ok).toBe(false);
  });
});

describe("sketch document structural rejection", () => {
  it("rejects duplicate object ids", () => {
    const document = nonPlanarSketchDocument();
    document.objects.push({ ...document.objects[0] });
    const parsed = parseSketchDocument(JSON.stringify(document));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("Duplicate object id");
    }
  });

  it("rejects missing parents, self-parents, and parent cycles", () => {
    const base = nonPlanarSketchDocument();
    const withMissing = {
      ...base,
      objects: [{ id: "lonely", kind: "box", size: [0.1, 0.1, 0.1], parentId: "ghost" }]
    };
    expect(parseSketchDocument(JSON.stringify(withMissing)).ok).toBe(false);

    const withSelf = {
      ...base,
      objects: [{ id: "selfish", kind: "box", size: [0.1, 0.1, 0.1], parentId: "selfish" }]
    };
    const selfParsed = parseSketchDocument(JSON.stringify(withSelf));
    expect(selfParsed.ok).toBe(false);
    if (!selfParsed.ok) {
      expect(selfParsed.error.message).toContain("own parent");
    }

    const withCycle = {
      ...base,
      objects: [
        { id: "a", kind: "group", parentId: "b" },
        { id: "b", kind: "group", parentId: "a" }
      ]
    };
    const cycleParsed = parseSketchDocument(JSON.stringify(withCycle));
    expect(cycleParsed.ok).toBe(false);
    if (!cycleParsed.ok) {
      expect(cycleParsed.error.message).toContain("cycle");
    }
  });

  it("rejects nesting beyond four group levels", () => {
    const objects = [
      { id: "b1", kind: "box", size: [0.1, 0.1, 0.1], parentId: "g4" },
      { id: "g1", kind: "group" },
      { id: "g2", kind: "group", parentId: "g1" },
      { id: "g3", kind: "group", parentId: "g2" },
      { id: "g4", kind: "group", parentId: "g3" }
    ];
    const parsed = parseSketchDocument(
      JSON.stringify({ ...nonPlanarSketchDocument(), objects })
    );
    expect(parsed.ok).toBe(true); // exactly four levels is legal

    const deeper = parseSketchDocument(
      JSON.stringify({
        ...nonPlanarSketchDocument(),
        objects: [
          ...objects,
          { id: "g5", kind: "group", parentId: "g4" },
          { id: "b2", kind: "box", size: [0.1, 0.1, 0.1], parentId: "g5" }
        ]
      })
    );
    expect(deeper.ok).toBe(false);
    if (!deeper.ok) {
      expect(deeper.error.message).toContain("group levels");
    }
  });

  it("rejects stored geometry a composed parent transform carries out of bounds", () => {
    const objects = [
      {
        id: "parent",
        kind: "group",
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [2, 2, 2]
        }
      },
      {
        id: "child",
        kind: "box",
        size: [1, 1, 1],
        parentId: "parent",
        transform: {
          translation: [3, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        }
      }
    ];
    const parsed = parseSketchDocument(
      JSON.stringify({ ...nonPlanarSketchDocument(), objects })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("child");
    }
  });
});

describe("sketch state durability", () => {
  it("round trips state including history and receipts, and undo keeps working", () => {
    const state = commitFromFixture();
    const moved = evaluateSketchCommit(state, {
      requestId: "move",
      baseRevision: state.document.revision,
      actor: human,
      operations: [
        {
          op: "transform",
          objectId: "fixture-box",
          transform: {
            translation: [0.4, 0, 0.2],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1]
          }
        }
      ]
    });
    expect(moved.ok).toBe(true);
    const withHistory = moved.ok ? moved.state : state;

    const serialized = serializeSketchState(withHistory);
    const parsed = parseSketchState(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(withHistory);
    expect(serializeSketchState(parsed.value)).toBe(serialized);

    // The reloaded state can still undo: history entries carry the internal
    // inverse operations through storage.
    const undone = undoSketchTransaction(parsed.value, {
      requestId: "undo-after-reload",
      baseRevision: parsed.value.document.revision,
      actor: human
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    const box = undone.state.document.objects.find(
      (object) => object.id === "fixture-box"
    );
    expect(box).toMatchObject({
      transform: { translation: [0.28, 0.02, 0.14] }
    });
  });

  it("migrates v1 document and restore history while keeping undo and redo usable", () => {
    const created = commitFromFixture();
    const deleted = evaluateSketchCommit(created, {
      requestId: "delete-legacy-stroke",
      baseRevision: created.document.revision,
      actor: human,
      operations: [{ op: "delete", objectId: "fixture-helix" }]
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;

    const legacy = JSON.parse(serializeSketchState(deleted.state));
    legacy.schemaVersion = 1;
    legacy.document.schemaVersion = 1;
    const stripStrokeStyle = (object: Record<string, unknown>) => {
      if (object.kind === "stroke") {
        delete object.brush;
        delete object.lineStyle;
      }
    };
    for (const object of legacy.document.objects) stripStrokeStyle(object);
    for (const entry of [...legacy.history.undo, ...legacy.history.redo]) {
      for (const operation of [...entry.forwardOps, ...entry.inverseOps]) {
        if (operation.op === "create" && operation.kind === "stroke") {
          delete operation.brush;
          delete operation.lineStyle;
        }
        if (operation.op === "restore") {
          for (const object of operation.objects) stripStrokeStyle(object);
        }
      }
    }

    const parsed = parseSketchState(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(SKETCH_SCHEMA_VERSION);
    expect(parsed.value.history.undo).toHaveLength(deleted.state.history.undo.length);
    expect(parsed.value.receipts).toEqual(deleted.state.receipts);

    const undone = undoSketchTransaction(parsed.value, {
      requestId: "undo-v1-delete",
      baseRevision: parsed.value.document.revision,
      actor: human
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects.find((object) => object.id === "fixture-helix")).toMatchObject({
      brush: "finePen",
      lineStyle: "solid"
    });

    const redone = evaluateSketchCommit(undone.state, {
      requestId: "redo-v1-delete",
      baseRevision: undone.state.document.revision,
      actor: human,
      operations: [{ op: "delete", objectId: "fixture-helix" }]
    });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.state.document.objects.some((object) => object.id === "fixture-helix")).toBe(false);
  });

  it("rejects state whose document and state sketch ids disagree", () => {
    const state = commitFromFixture();
    const doctored = JSON.parse(serializeSketchState(state));
    doctored.document.sketchId = "sketch-other";
    const parsed = parseSketchState(JSON.stringify(doctored));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("sketch id");
    }
  });

  it("rejects a stored history entry carrying caller-forbidden internals with bad shape", () => {
    // Internal ops are legal only inside history; a malformed one (here a
    // restore with no objects) is corruption, not input.
    const state = commitFromFixture();
    const doctored = JSON.parse(serializeSketchState(state));
    doctored.history.undo[0].inverseOps = [{ op: "restore", objects: [] }];
    const parsed = parseSketchState(JSON.stringify(doctored));
    expect(parsed.ok).toBe(false);
  });
});
