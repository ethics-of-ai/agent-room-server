import type { SketchCallerOperation, SketchDocument, SketchOperation } from "./schemas";
import { unknownObjectError, type SketchCoreError } from "./errors";
import { findSketchPieceEntry, sketchPieceEntry } from "./pieceCatalog";
import {
  firstPieceOffTable,
  isSketchPiece,
  landingLevel,
  pieceAcceptsText,
  sameCell,
  settleColumn,
  textNotAllowedMessage
} from "./pieceRules";
import { resolveSketchTable, sketchTableCells, type SketchPieceObject, type SketchTable } from "./pieceSchemas";

// Create, update, delete and table operations for pieces. Gravity runs here:
// a piece lands on top of the column it names, and the pieces above a piece
// that leaves drop to close the gap. Every level a step changes goes into one
// `setPieces` inverse, so a single undo puts each column back exactly.

type PieceCreate = Extract<SketchCallerOperation, { op: "create"; kind: "piece" }>;
type PieceUpdate = Extract<SketchCallerOperation, { op: "update"; kind: "piece" }>;
type Applied = { ok: true; inverse: SketchOperation[] } | { ok: false; error: SketchCoreError };

export function applyPieceCreate(document: SketchDocument, operation: PieceCreate): Applied {
  const entry = findSketchPieceEntry(operation.catalogId);
  if (entry === undefined) {
    return { ok: false, error: unknownPieceError(operation.catalogId) };
  }
  if (operation.text !== undefined && !pieceAcceptsText(operation.catalogId)) {
    return { ok: false, error: textNotAllowedError(operation.objectId, operation.catalogId) };
  }
  const landing = landingLevel(document.objects, entry, operation.cell);
  if (!landing.ok) {
    return { ok: false, error: { code: "piece_blocked", message: landing.reason } };
  }
  document.objects.push({
    id: operation.objectId,
    kind: "piece",
    catalogId: operation.catalogId,
    cell: [operation.cell[0], operation.cell[1]],
    level: landing.level,
    rotation: operation.rotation,
    ...(operation.color === undefined ? {} : { color: operation.color }),
    ...(operation.text === undefined ? {} : { text: operation.text })
  });
  return { ok: true, inverse: [{ op: "remove", objectIds: [operation.objectId] }] };
}

export function applyPieceUpdate(document: SketchDocument, piece: SketchPieceObject, operation: PieceUpdate): Applied {
  // A piece this build has no catalog entry for keeps its record unchanged;
  // a newer build may give its fields meanings this one cannot check.
  if (findSketchPieceEntry(piece.catalogId) === undefined) {
    return { ok: false, error: unknownPieceError(piece.catalogId) };
  }
  const before = [structuredClone(piece)];
  if (operation.text !== undefined) {
    if (operation.text === null) {
      delete piece.text;
    } else if (!pieceAcceptsText(piece.catalogId)) {
      return { ok: false, error: textNotAllowedError(piece.id, piece.catalogId) };
    } else {
      piece.text = operation.text;
    }
  }
  if (operation.color !== undefined) {
    if (operation.color === null) {
      delete piece.color;
    } else {
      piece.color = operation.color;
    }
  }
  if (operation.rotation !== undefined) {
    piece.rotation = operation.rotation;
  }
  if (operation.cell !== undefined && !sameCell(operation.cell, piece.cell)) {
    const landing = landingLevel(document.objects, sketchPieceEntry(piece.catalogId), operation.cell, piece.id);
    if (!landing.ok) {
      return { ok: false, error: { code: "piece_blocked", message: landing.reason } };
    }
    const source = piece.cell;
    piece.cell = [operation.cell[0], operation.cell[1]];
    piece.level = landing.level;
    before.push(...settleColumn(document.objects, source));
  }
  return { ok: true, inverse: [{ op: "setPieces", pieces: before, removeIds: [] }] };
}

export function applyPieceDelete(document: SketchDocument, piece: SketchPieceObject): Applied {
  const removed = structuredClone(piece);
  document.objects = document.objects.filter((object) => object.id !== piece.id);
  const dropped = settleColumn(document.objects, removed.cell);
  return { ok: true, inverse: [{ op: "setPieces", pieces: [removed, ...dropped], removeIds: [] }] };
}

export function applySetTable(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "setTable" }>
): Applied {
  const table = operation.cellSize === null
    ? resolveSketchTable(undefined)
    : { cellSize: operation.cellSize, cells: sketchTableCells(operation.cellSize) };
  const outside = firstPieceOffTable(document.objects, table);
  if (outside !== undefined) {
    return {
      ok: false,
      error: {
        code: "out_of_bounds",
        message: `A ${table.cellSize} m cell makes the table ${table.cells} cells across, which leaves piece ` +
          `"${outside.id}" at [${outside.cell.join(", ")}] off it; move or delete the pieces past column or row ${table.cells - 1} first`
      }
    };
  }
  return writeTable(document, operation.cellSize === null ? null : table);
}

export function applyRestoreTable(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "restoreTable" }>
): Applied {
  return writeTable(document, operation.table);
}

function writeTable(document: SketchDocument, table: SketchTable | null): Applied {
  const previous = document.table === undefined ? null : { ...document.table };
  if (table === null) {
    delete document.table;
  } else {
    document.table = { cellSize: table.cellSize, cells: table.cells };
  }
  return { ok: true, inverse: [{ op: "restoreTable", table: previous }] };
}

// Removes first, then writes each record in place or appends it. The inverse
// writes back what was there and removes what was appended.
export function applySetPieces(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "setPieces" }>
): Applied {
  const written = new Set(operation.pieces.map((piece) => piece.id));
  if (written.size !== operation.pieces.length || operation.removeIds.some((id) => written.has(id))) {
    return { ok: false, error: { code: "invalid_operation", message: "setPieces names a piece more than once" } };
  }
  const inversePieces: SketchPieceObject[] = [];
  const inverseRemoveIds: string[] = [];
  for (const objectId of operation.removeIds) {
    const object = document.objects.find((candidate) => candidate.id === objectId);
    if (object === undefined) {
      return { ok: false, error: unknownObjectError(objectId) };
    }
    if (!isSketchPiece(object)) {
      return { ok: false, error: notAPieceError(objectId, object.kind) };
    }
    inversePieces.push(structuredClone(object));
  }
  const removed = new Set(operation.removeIds);
  document.objects = document.objects.filter((object) => !removed.has(object.id));
  for (const piece of operation.pieces) {
    const index = document.objects.findIndex((candidate) => candidate.id === piece.id);
    if (index === -1) {
      document.objects.push(structuredClone(piece));
      inverseRemoveIds.push(piece.id);
      continue;
    }
    const existing = document.objects[index];
    if (!isSketchPiece(existing)) {
      return { ok: false, error: notAPieceError(piece.id, existing.kind) };
    }
    inversePieces.push(structuredClone(existing));
    document.objects[index] = structuredClone(piece);
  }
  return { ok: true, inverse: [{ op: "setPieces", pieces: inversePieces, removeIds: inverseRemoveIds }] };
}

function unknownPieceError(catalogId: string): SketchCoreError {
  return { code: "unknown_piece", message: `"${catalogId}" is not a piece in the catalog` };
}

function textNotAllowedError(objectId: string, catalogId: string): SketchCoreError {
  return { code: "invalid_operation", message: textNotAllowedMessage(objectId, catalogId) };
}

function notAPieceError(objectId: string, kind: string): SketchCoreError {
  return { code: "invalid_operation", message: `Object "${objectId}" is a ${kind}, not a piece` };
}
