import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  SKETCH_PIECE_CATALOG,
  SKETCH_SCHEMA_VERSION,
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  resolveSketchTable,
  type sketchCallerOperationSchema,
  type SketchErrorCode,
  type SketchState
} from "../src/sketch/core";
import type { SketchPieceObject, SketchTable } from "../src/sketch/core/pieceSchemas";

// Gravity cases shared with the visionOS suite (`SketchPieceRuleCasesTests`),
// which folds the same edits through the client's copy of the rules. This
// suite commits them through the real commit path, so a case also catches a
// rule the operations skip. The fixture's format is in
// docs/plans/SKETCH_PIECE_ENGINE_PLAN.md, step 2.

type Cell = [number, number];
// What a caller sends, before the schema fills defaults such as a create's rotation.
type CallerOperation = z.input<typeof sketchCallerOperationSchema>;

type Edit =
  | { place: string; id: string; at: Cell; rotation?: number }
  | { move: string; to: Cell }
  | { delete: string }
  | { setTable: number | null };

interface RuleCase {
  name: string;
  table?: SketchTable;
  pieces: Record<string, unknown>[];
  edits: Edit[];
  expect:
    | { pieces: Record<string, [number, number, number]>; table?: SketchTable }
    | { refused: SketchErrorCode };
  backendOnly?: string;
}

const cases: RuleCase[] = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/sketchPieceRuleCases.json"), "utf8")
);

function seed(ruleCase: RuleCase): SketchState {
  const parsed = parseSketchDocument(JSON.stringify({
    schemaVersion: SKETCH_SCHEMA_VERSION,
    kind: "sketch",
    sketchId: "rules",
    revision: 0,
    ...(ruleCase.table === undefined ? {} : { table: ruleCase.table }),
    objects: ruleCase.pieces
  }));
  if (!parsed.ok) throw new Error(`${ruleCase.name}: the case's pieces do not load: ${parsed.error.message}`);
  return { ...createSketchState("rules"), document: parsed.value };
}

function operation(edit: Edit): CallerOperation {
  if ("place" in edit) {
    return {
      op: "create",
      objectId: edit.id,
      kind: "piece",
      catalogId: edit.place,
      cell: edit.at,
      ...(edit.rotation === undefined ? {} : { rotation: edit.rotation })
    };
  }
  if ("move" in edit) return { op: "update", objectId: edit.move, kind: "piece", cell: edit.to };
  if ("delete" in edit) return { op: "delete", objectId: edit.delete };
  return { op: "setTable", cellSize: edit.setTable };
}

describe("shared piece rule cases", () => {
  it.each(cases.map((ruleCase) => [ruleCase.name, ruleCase] as const))("%s", (name, ruleCase) => {
    const result = evaluateSketchCommit(seed(ruleCase), {
      requestId: "rules",
      baseRevision: 0,
      actor: { kind: "human", name: "Tester" },
      operations: ruleCase.edits.map(operation)
    });
    if ("refused" in ruleCase.expect) {
      expect(ruleCase.edits, `${name}: a refusal case has one edit`).toHaveLength(1);
      expect(result.ok ? "applied" : result.error.code, name).toBe(ruleCase.expect.refused);
      // A schema failure names no operation; every other refusal names the one edit.
      if (!result.ok && result.error.code !== "invalid_request") expect(result.error.opIndex, name).toBe(0);
      return;
    }
    if (!result.ok) throw new Error(`${name}: refused as ${result.error.code}: ${result.error.message}`);
    const pieces = Object.fromEntries(result.state.document.objects
      .filter((object): object is SketchPieceObject => object.kind === "piece")
      .map((piece) => [piece.id, [piece.cell[0], piece.cell[1], piece.level]]));
    expect(pieces, name).toEqual(ruleCase.expect.pieces);
    if (ruleCase.expect.table !== undefined) {
      expect(resolveSketchTable(result.state.document.table), name).toEqual(ruleCase.expect.table);
    }
  });

  it("names every case uniquely", () => {
    const names = cases.map((ruleCase) => ruleCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses every catalog entry in some case", () => {
    const used = new Set(cases.flatMap((ruleCase) => [
      ...ruleCase.pieces.map((piece) => piece.catalogId),
      ...ruleCase.edits.flatMap((edit) => ("place" in edit ? [edit.place] : []))
    ]));
    expect(SKETCH_PIECE_CATALOG.map((entry) => entry.id).filter((id) => !used.has(id))).toEqual([]);
  });
});
