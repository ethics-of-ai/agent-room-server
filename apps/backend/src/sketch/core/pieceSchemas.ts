import { z } from "zod";
import {
  SKETCH_MAX_OBJECTS,
  SKETCH_MAX_PIECE_TEXT_CHARACTERS,
  SKETCH_DEFAULT_TABLE_CELL_SIZE,
  SKETCH_MAX_TABLE_CELLS,
  SKETCH_MAX_TABLE_CELL_SIZE,
  SKETCH_MIN_TABLE_CELL_SIZE,
  SKETCH_PIECE_MAX_LEVELS,
  SKETCH_TABLE_WIDTH
} from "./limits";
import { sketchColorSchema, sketchObjectIdSchema } from "./fieldSchemas";

// Tables and pieces (schema version 4). A sketch's table is a square board of
// `cells` by `cells` cells on the y = 0 plane, and it is the whole board:
// every piece stands on it. Cell (c, r), with c and r from 0 to cells − 1,
// has its centre at x = (c + 0.5) × cellSize, z = (r + 0.5) × cellSize, and
// level l sits at y = l × cellSize. A piece names a catalog entry and the cell, level and
// quarter turn it occupies. It has no transform and no parent: its place is
// the grid, and gravity, not a caller, decides its level (`pieceRules.ts`).

export const sketchCatalogIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, {
  message: "Catalog ids must match ^[a-z0-9][a-z0-9.-]{0,63}$"
});
// The widest table's range. The invariants hold a piece to its own table.
const cellComponentSchema = z.number().int().min(0).max(SKETCH_MAX_TABLE_CELLS - 1);
export const sketchPieceCellSchema = z.tuple([cellComponentSchema, cellComponentSchema]);
const pieceLevelSchema = z.number().int().min(0).max(SKETCH_PIECE_MAX_LEVELS - 1);
// Quarter turns clockwise seen from above.
const pieceRotationSchema = z.number().int().min(0).max(3);
const pieceTextSchema = z.string().min(1).max(SKETCH_MAX_PIECE_TEXT_CHARACTERS);

export const sketchTableCellSizeSchema = z
  .number()
  .finite()
  .min(SKETCH_MIN_TABLE_CELL_SIZE)
  .max(SKETCH_MAX_TABLE_CELL_SIZE);

/** The board's width in cells that a cell size gives: 40 at 2 cm, 4 at 20 cm. */
export function sketchTableCells(cellSize: number): number {
  return Math.round(SKETCH_TABLE_WIDTH / cellSize);
}

// `cells` is stored, so a file keeps its board if the table width changes. A
// board is never wider than its cell size gives, so the slab fits the volume.
export const sketchTableSchema = z.object({
  cellSize: sketchTableCellSizeSchema,
  cells: z.number().int().min(1).max(SKETCH_MAX_TABLE_CELLS)
}).strict().refine(
  (table) => table.cells <= sketchTableCells(table.cellSize),
  { message: `A table is at most round(${SKETCH_TABLE_WIDTH} / cellSize) cells across` }
);

/** A document's table, or the default board when it has none. */
export function resolveSketchTable(table: SketchTable | undefined): SketchTable {
  return table ?? { cellSize: SKETCH_DEFAULT_TABLE_CELL_SIZE, cells: sketchTableCells(SKETCH_DEFAULT_TABLE_CELL_SIZE) };
}

export const sketchPieceObjectSchema = z.object({
  id: sketchObjectIdSchema,
  kind: z.literal("piece"),
  catalogId: sketchCatalogIdSchema,
  cell: sketchPieceCellSchema,
  level: pieceLevelSchema,
  rotation: pieceRotationSchema,
  color: sketchColorSchema.optional(),
  text: pieceTextSchema.optional()
}).strict();

// A create names a column, never a level: the piece lands on top of it.
export const sketchPieceCreateSchema = z.object({
  op: z.literal("create"),
  objectId: sketchObjectIdSchema,
  kind: z.literal("piece"),
  catalogId: sketchCatalogIdSchema,
  cell: sketchPieceCellSchema,
  rotation: pieceRotationSchema.default(0),
  color: sketchColorSchema.optional(),
  text: pieceTextSchema.optional()
}).strict();

// A new `cell` moves the piece to the top of that column. `null` clears a
// colour or a label's text.
export const sketchPieceUpdateSchema = z.object({
  op: z.literal("update"),
  objectId: sketchObjectIdSchema,
  kind: z.literal("piece"),
  cell: sketchPieceCellSchema.optional(),
  rotation: pieceRotationSchema.optional(),
  color: sketchColorSchema.nullable().optional(),
  text: pieceTextSchema.nullable().optional()
}).strict().refine(
  (op) => op.cell !== undefined || op.rotation !== undefined || op.color !== undefined || op.text !== undefined,
  { message: "An update must carry at least one field" }
);

// `null` removes the table, which reads as the default cell size. The board
// takes the width in cells that the cell size gives, and the operation refuses
// a size that would leave a piece off the board.
export const sketchSetTableOperationSchema = z.object({
  op: z.literal("setTable"),
  cellSize: sketchTableCellSizeSchema.nullable()
}).strict();

// History-internal, like `restore`: puts back the exact table `setTable`
// replaced, its stored width included.
export const sketchRestoreTableOperationSchema = z.object({
  op: z.literal("restoreTable"),
  table: sketchTableSchema.nullable()
}).strict();

// History-internal, like `restore`: removes the named pieces, then writes the
// given piece records in place (or appends them), all as one operation so a
// column is never checked half restored.
export const sketchSetPiecesOperationSchema = z.object({
  op: z.literal("setPieces"),
  pieces: z.array(sketchPieceObjectSchema).max(SKETCH_MAX_OBJECTS),
  removeIds: z.array(sketchObjectIdSchema).max(SKETCH_MAX_OBJECTS)
}).strict().refine(
  (op) => op.pieces.length + op.removeIds.length > 0,
  { message: "setPieces must change at least one piece" }
);

export type SketchTable = z.infer<typeof sketchTableSchema>;
export type SketchPieceObject = z.infer<typeof sketchPieceObjectSchema>;
export type SketchPieceCell = z.infer<typeof sketchPieceCellSchema>;
