import { SKETCH_PIECE_MAX_LEVELS } from "./limits";
import { SKETCH_PIECE_CATALOG, findSketchPieceEntry, sketchPieceEntry, type SketchPieceCatalogEntry } from "./pieceCatalog";
import type { SketchPieceCell, SketchPieceObject, SketchTable } from "./pieceSchemas";

// Gravity for pieces. Every column of the table is a stack: levels start at 0
// and follow each other without gaps, each piece starting where the one below
// it ends, and only the top piece may be one that nothing stacks on. The
// backend owns this rule, so a caller names a column and never a level.

interface ObjectLike {
  id: string;
  kind: string;
}

export function isSketchPiece(object: ObjectLike): object is SketchPieceObject {
  return object.kind === "piece";
}

export function sameCell(a: SketchPieceCell, b: SketchPieceCell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** The pieces in one column, bottom first. */
export function columnPieces(
  objects: readonly ObjectLike[],
  cell: SketchPieceCell,
  excludedId?: string
): SketchPieceObject[] {
  return objects
    .filter((object): object is SketchPieceObject =>
      isSketchPiece(object) && object.id !== excludedId && sameCell(object.cell, cell))
    .sort((a, b) => a.level - b.level);
}

export type SketchLanding =
  | { ok: true; level: number }
  | { ok: false; reason: string };

/** Where a piece of this entry lands in a column: on top of its stack. */
export function landingLevel(
  objects: readonly ObjectLike[],
  entry: SketchPieceCatalogEntry,
  cell: SketchPieceCell,
  excludedId?: string
): SketchLanding {
  const stack = columnPieces(objects, cell, excludedId);
  const top = stack.at(-1);
  if (top !== undefined && !sketchPieceEntry(top.catalogId).stacksOnTop) {
    return { ok: false, reason: `Column [${cell.join(", ")}] is topped by "${top.id}" (${top.catalogId}), which nothing stacks on` };
  }
  const level = top === undefined ? 0 : top.level + sketchPieceEntry(top.catalogId).levels;
  if (level + entry.levels > SKETCH_PIECE_MAX_LEVELS) {
    return { ok: false, reason: `Column [${cell.join(", ")}] has no room for ${entry.levels} more level(s) under the ${SKETCH_PIECE_MAX_LEVELS}-level ceiling` };
  }
  return { ok: true, level };
}

/**
 * Restacks a column from the floor so no piece floats, keeping its order.
 * Returns each changed piece as it was before, for the inverse.
 */
export function settleColumn(objects: readonly ObjectLike[], cell: SketchPieceCell): SketchPieceObject[] {
  const before: SketchPieceObject[] = [];
  let level = 0;
  for (const piece of columnPieces(objects, cell)) {
    if (piece.level !== level) {
      before.push(structuredClone(piece));
      piece.level = level;
    }
    level += sketchPieceEntry(piece.catalogId).levels;
  }
  return before;
}

/**
 * Whether a piece may store text: its entry carries text. An unknown catalog
 * id keeps whatever it stored, since a newer build may allow text there.
 */
export function pieceAcceptsText(catalogId: string): boolean {
  return findSketchPieceEntry(catalogId)?.carriesText ?? true;
}

/** The first piece off a board of `table.cells` cells. */
export function firstPieceOffTable(objects: readonly ObjectLike[], table: SketchTable): SketchPieceObject | undefined {
  return objects.filter(isSketchPiece).find((piece) => !isOnTable(piece.cell, table));
}

/** The first piece off a board of `table.cells` cells, as caller-facing prose. */
export function checkPieceBounds(objects: readonly ObjectLike[], table: SketchTable): { objectId: string; message: string } | null {
  const outside = firstPieceOffTable(objects, table);
  if (outside === undefined) return null;
  return {
    objectId: outside.id,
    message: `Piece "${outside.id}" at [${outside.cell.join(", ")}] is off the table, which is ${table.cells} cells across: ` +
      `columns and rows run 0 to ${table.cells - 1}`
  };
}

export function isOnTable(cell: SketchPieceCell, table: SketchTable): boolean {
  return cell[0] < table.cells && cell[1] < table.cells;
}

export function textNotAllowedMessage(objectId: string, catalogId: string): string {
  const carriers = SKETCH_PIECE_CATALOG.filter((entry) => entry.carriesText).map((entry) => entry.id);
  return `Piece "${objectId}" is a ${catalogId}; only pieces that carry text do: ${carriers.join(", ")}`;
}

/**
 * The first piece record that breaks a piece rule, as caller-facing prose:
 * a piece in a group or parenting an object, text on a piece whose entry
 * carries none, or a column that floats, stacks on a top that takes nothing, or
 * passes the level ceiling.
 */
export function checkPieceRecords(objects: readonly ObjectLike[]): { objectId: string; message: string } | null {
  const pieces = objects.filter(isSketchPiece);
  const pieceIds = new Set(pieces.map((piece) => piece.id));
  for (const object of objects) {
    const parentId = (object as { parentId?: unknown }).parentId;
    if (isSketchPiece(object) && parentId !== undefined) {
      return { objectId: object.id, message: `Piece "${object.id}" cannot belong to a group; pieces sit on the table` };
    }
    if (typeof parentId === "string" && pieceIds.has(parentId)) {
      return { objectId: object.id, message: `Object "${object.id}" cannot have piece "${parentId}" as its parent` };
    }
  }
  const checked = new Set<string>();
  for (const piece of pieces) {
    if (!pieceAcceptsText(piece.catalogId) && piece.text !== undefined) {
      return { objectId: piece.id, message: textNotAllowedMessage(piece.id, piece.catalogId) };
    }
    const key = `${piece.cell[0]},${piece.cell[1]}`;
    if (checked.has(key)) continue;
    checked.add(key);
    let level = 0;
    const stack = columnPieces(pieces, piece.cell);
    for (const [index, member] of stack.entries()) {
      const entry = sketchPieceEntry(member.catalogId);
      if (member.level !== level) {
        return {
          objectId: member.id,
          message: `Piece "${member.id}" sits at level ${member.level} in column [${key}], where the stack reaches level ${level}`
        };
      }
      if (index < stack.length - 1 && !entry.stacksOnTop) {
        return { objectId: member.id, message: `Piece "${member.id}" (${member.catalogId}) has a piece on top, but nothing stacks on it` };
      }
      level += entry.levels;
    }
    if (level > SKETCH_PIECE_MAX_LEVELS) {
      return { objectId: piece.id, message: `Column [${key}] reaches level ${level}; the ceiling is ${SKETCH_PIECE_MAX_LEVELS}` };
    }
  }
  return null;
}
