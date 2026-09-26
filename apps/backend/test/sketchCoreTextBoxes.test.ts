import { describe, expect, it } from "vitest";
import {
  SKETCH_MAX_SHAPE_SEGMENTS,
  checkSketchObjects,
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  redoSketchTransaction,
  serializeSketchDocument,
  undoSketchTransaction,
  type SketchCommitRequest,
  type SketchState
} from "../src/sketch/core";

const human = { kind: "human", name: "Tester" } as const;
type TextBoxCreate = Extract<SketchCommitRequest["operations"][number], { kind: "textBox" }>;

function textBox(objectId: string, overrides: Partial<TextBoxCreate> = {}): TextBoxCreate {
  return {
    op: "create",
    objectId,
    kind: "textBox",
    text: "A short note",
    color: "#112233cc",
    size: [0.3, 0.2],
    appearance: "fillAndOutline",
    fillColor: "#44556680",
    outlineColor: "#778899",
    outlineWidth: 0.004,
    ...overrides
  };
}

function commit(state: SketchState, requestId: string, operations: SketchCommitRequest["operations"]) {
  return evaluateSketchCommit(state, {
    requestId,
    baseRevision: state.document.revision,
    actor: human,
    operations
  });
}

describe("text-box sketch objects", () => {
  it("serializes text, text color, panel appearance, and bounds canonically", () => {
    const result = commit(createSketchState("textbox-canonical"), "create", [textBox("note-1")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = serializeSketchDocument(result.state.document);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok).toBe(true);
    const stored = JSON.parse(serialized).objects[0];
    expect(stored).toMatchObject({
      id: "note-1",
      kind: "textBox",
      text: "A short note",
      color: "#112233cc",
      size: [0.3, 0.2],
      appearance: "fillAndOutline",
      fillColor: "#44556680",
      outlineColor: "#778899",
      outlineWidth: 0.004
    });
    expect(Object.keys(stored)).toEqual([
      "id", "kind", "text", "color", "font", "paragraphs", "spans", "rendering",
      "extrusionDepth", "size", "appearance", "fillColor", "outlineColor",
      "outlineWidth", "transform"
    ]);
  });

  it("undoes and redoes text, size, color, and panel appearance together", () => {
    const created = commit(createSketchState("textbox-undo"), "create", [textBox("note-1")]);
    if (!created.ok) throw new Error("text-box create failed");
    const edited = commit(created.state, "edit", [{
      op: "update",
      objectId: "note-1",
      kind: "textBox",
      text: "Revised note",
      color: "#abcdef",
      paragraphs: [{ style: "body", alignment: "leading", list: "none" }],
      spans: [],
      size: [0.5, 0.25],
      appearance: "outline",
      fillColor: "#010203",
      outlineColor: "#aabbccdd",
      outlineWidth: 0.012
    }]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const undone = undoSketchTransaction(edited.state, { requestId: "undo", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects[0]).toMatchObject({
      text: "A short note",
      color: "#112233cc",
      size: [0.3, 0.2],
      appearance: "fillAndOutline",
      fillColor: "#44556680",
      outlineColor: "#778899",
      outlineWidth: 0.004
    });

    const redone = redoSketchTransaction(undone.state, { requestId: "redo", baseRevision: 3, actor: human });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.state.document.objects[0]).toMatchObject({
      text: "Revised note", color: "#abcdef", size: [0.5, 0.25], appearance: "outline"
    });
  });

  it("rejects invalid dimensions, blank content, long content, and unknown fields", () => {
    const state = createSketchState("textbox-limits");
    for (const invalid of [
      textBox("tiny", { size: [0, 0.2] }),
      textBox("wide", { size: [10.001, 0.2] }),
      textBox("blank", { text: "" }),
      textBox("long", { text: "x".repeat(1001) }),
      { ...textBox("extra"), unexpected: true } as TextBoxCreate
    ]) {
      const result = commit(state, `invalid-${invalid.objectId}`, [invalid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_request");
    }
  });

  it("bounds the rotated panel and outline in the document cube", () => {
    const result = commit(createSketchState("textbox-bounds"), "outside", [textBox("note-1", {
      size: [0.4, 0.2],
      outlineWidth: 0.1,
      transform: {
        translation: [0, 4.9, 0],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [1, 1, 1]
      }
    })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("out_of_bounds");
  });

  it("includes text-box fill and outline passes in the shared segment budget", () => {
    const ellipses = Array.from({ length: SKETCH_MAX_SHAPE_SEGMENTS / 128 }, (_, index) => ({
      id: `ellipse-${index}`,
      kind: "planarShape" as const,
      shapeType: "ellipse" as const,
      size: [0.1, 0.1] as [number, number],
      appearance: "fillAndOutline" as const,
      fillColor: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0.004
    }));
    const box = {
      id: "note-1",
      kind: "textBox" as const,
      text: "Hello",
      font: { family: "system" as const, size: 0.0125 },
      paragraphs: [{ style: "body" as const, alignment: "leading" as const, list: "none" as const }],
      spans: [],
      rendering: "flat" as const,
      extrusionDepth: 0.02,
      size: [0.1, 0.1] as [number, number],
      appearance: "fillAndOutline" as const,
      fillColor: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0.004
    };
    expect(checkSketchObjects([...ellipses])).toBeNull();
    expect(checkSketchObjects([...ellipses, box])).toMatchObject({ kind: "shape_segments" });
    expect(checkSketchObjects([...ellipses, { ...box, appearance: "none" as const }])).toBeNull();
  });
  it("hides the whole panel with the text-box-only none appearance", () => {
    const created = commit(createSketchState("textbox-none"), "create", [textBox("note-1", { appearance: "none" })]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.state.document.objects[0]).toMatchObject({ appearance: "none", fillColor: "#44556680" });

    const boxed = commit(created.state, "box", [{ op: "update", objectId: "note-1", kind: "textBox", appearance: "fill" }]);
    if (!boxed.ok) throw new Error("text-box update failed");
    const undone = undoSketchTransaction(boxed.state, { requestId: "undo", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.state.document.objects[0]).toMatchObject({ appearance: "none" });

    const shape = commit(createSketchState("shape-none"), "shape", [{
      op: "create",
      objectId: "shape-1",
      kind: "planarShape",
      shapeType: "rectangle",
      size: [0.2, 0.2],
      appearance: "none" as "fill",
      fillColor: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0.004
    }]);
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.error.code).toBe("invalid_request");
  });

  it("refuses the none appearance in a version-2 file", () => {
    const parsed = parseSketchDocument(JSON.stringify({
      schemaVersion: 2,
      kind: "sketch",
      sketchId: "textbox-v2-none",
      revision: 1,
      objects: [{
        id: "note-1",
        kind: "textBox",
        text: "Hello",
        size: [0.1, 0.1],
        appearance: "none",
        fillColor: "#ffffff",
        outlineColor: "#000000",
        outlineWidth: 0.004
      }]
    }));
    expect(parsed.ok).toBe(false);
  });
});
