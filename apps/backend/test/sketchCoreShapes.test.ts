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
type PlanarShapeCreate = Extract<SketchCommitRequest["operations"][number], { kind: "planarShape" }>;

function planarShape(
  objectId: string,
  shapeType: "rectangle" | "ellipse" | "triangle" = "rectangle",
  appearance: "outline" | "fill" | "fillAndOutline" = "fillAndOutline"
): PlanarShapeCreate {
  return {
    op: "create",
    objectId,
    kind: "planarShape",
    shapeType,
    size: [0.4, 0.2],
    appearance,
    fillColor: "#1255aa80",
    outlineColor: "#ffcc00",
    outlineWidth: 0.004
  };
}

function commit(
  state: SketchState,
  requestId: string,
  operations: SketchCommitRequest["operations"]
) {
  return evaluateSketchCommit(state, {
    requestId,
    baseRevision: state.document.revision,
    actor: human,
    operations
  });
}

describe("planar sketch shapes", () => {
  it("round trips all shape fields in canonical order", () => {
    const result = commit(createSketchState("shape-canonical"), "create", [
      planarShape("shape-1", "ellipse", "outline")
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = serializeSketchDocument(result.state.document);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(serialized).objects[0]).toMatchObject({
      id: "shape-1",
      kind: "planarShape",
      shapeType: "ellipse",
      size: [0.4, 0.2],
      appearance: "outline",
      fillColor: "#1255aa80",
      outlineColor: "#ffcc00",
      outlineWidth: 0.004
    });
  });

  it("undoes and redoes independent appearance and bounds updates", () => {
    const created = commit(createSketchState("shape-undo"), "create", [planarShape("shape-1")]);
    if (!created.ok) throw new Error("shape create failed");
    const styled = commit(created.state, "style", [{
      op: "update",
      objectId: "shape-1",
      kind: "planarShape",
      size: [0.6, 0.3],
      appearance: "fill",
      fillColor: "#00aa00",
      outlineColor: "#1100cc",
      outlineWidth: 0.02
    }]);
    expect(styled.ok).toBe(true);
    if (!styled.ok) return;

    expect(styled.state.document.objects[0]).toMatchObject({
      size: [0.6, 0.3], appearance: "fill", fillColor: "#00aa00", outlineColor: "#1100cc", outlineWidth: 0.02
    });
    const undone = undoSketchTransaction(styled.state, { requestId: "undo", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects[0]).toMatchObject({
      size: [0.4, 0.2], appearance: "fillAndOutline", fillColor: "#1255aa80", outlineColor: "#ffcc00", outlineWidth: 0.004
    });
    const redone = redoSketchTransaction(undone.state, { requestId: "redo", baseRevision: 3, actor: human });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.state.document.objects[0]).toMatchObject({ appearance: "fill", size: [0.6, 0.3] });
  });

  it("keeps shape geometry through transforms, grouping, undo, and ungroup", () => {
    const created = commit(createSketchState("shape-group"), "create", [planarShape("shape-1", "triangle", "outline")]);
    if (!created.ok) throw new Error("shape create failed");
    const transformed = commit(created.state, "transform", [{
      op: "transform",
      objectId: "shape-1",
      transform: {
        translation: [0.2, -0.1, 0.3],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [2, 1.5, 1]
      }
    }]);
    if (!transformed.ok) throw new Error("shape transform failed");
    const grouped = commit(transformed.state, "group", [{
      op: "group",
      groupId: "group-1",
      memberIds: ["shape-1"]
    }]);
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(grouped.state.document.objects.find((object) => object.id === "shape-1")).toMatchObject({
      kind: "planarShape",
      shapeType: "triangle",
      appearance: "outline",
      transform: {
        translation: [0.2, -0.1, 0.3],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [2, 1.5, 1]
      },
      parentId: "group-1"
    });

    const undone = undoSketchTransaction(grouped.state, { requestId: "undo-group", baseRevision: 3, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects.find((object) => object.id === "shape-1")?.parentId).toBeUndefined();
    const serialized = serializeSketchDocument(undone.state.document);
    const reopened = parseSketchDocument(serialized);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.objects[0]).toMatchObject({
      kind: "planarShape",
      shapeType: "triangle",
      transform: { translation: [0.2, -0.1, 0.3] }
    });
  });

  it("checks rotated bounds including the visible outline", () => {
    const result = commit(createSketchState("shape-bounds"), "outside", [{
      ...planarShape("shape-1", "rectangle", "outline"),
      size: [2, 0.2],
      outlineWidth: 0.1,
      transform: {
        translation: [0, 4.3, 0],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [1, 1, 1]
      }
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("out_of_bounds");
  });

  it("caps document-wide fill and outline tessellation work", () => {
    const shape = (index: number) => ({
      id: `ellipse-${index}`,
      kind: "planarShape" as const,
      shapeType: "ellipse" as const,
      size: [0.1, 0.1] as [number, number],
      appearance: "fillAndOutline" as const,
      fillColor: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0.004
    });
    const withinBudget = Array.from({ length: SKETCH_MAX_SHAPE_SEGMENTS / 128 }, (_, index) => shape(index));
    expect(checkSketchObjects(withinBudget)).toBeNull();
    const exceeded = [...withinBudget, shape(withinBudget.length)];
    expect(checkSketchObjects(exceeded)).toMatchObject({ kind: "shape_segments" });
  });
});
