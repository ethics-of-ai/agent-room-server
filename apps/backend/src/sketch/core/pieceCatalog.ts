// The built-in piece catalog: what each catalog id means for placement. A
// piece stores only its catalog id; clients draw it from the same id. An id
// never changes meaning, so a new shape or footprint gets a new id.
// `apps/shared/AgentRoomClient` mirrors these semantic fields, and a backend
// test keeps the two in step.
//
// Every entry covers one cell. The stacking rules in `pieceRules.ts` assume
// that, so a larger footprint needs those rules extended first.

/**
 * A piece's edges at rotation 0, clockwise seen from above: `back` is -z,
 * the way the piece faces. Each quarter turn moves an edge one place along.
 */
export const SKETCH_PIECE_EDGES = ["back", "right", "front", "left"] as const;
export type SketchPieceEdge = (typeof SKETCH_PIECE_EDGES)[number];

export interface SketchPieceCatalogEntry {
  id: string;
  title: string;
  /** Cells covered, columns by rows. */
  footprint: readonly [number, number];
  /** Levels the piece fills; the next piece in its column starts this many levels up. */
  levels: number;
  /** Visible height in cells, which can be less than `levels` (a road). */
  height: number;
  /** Whether another piece may stand on this one. */
  stacksOnTop: boolean;
  /** Whether the piece may store text. Clients draw that text only on `block.label` for now. */
  carriesText: boolean;
  /** The edges a pipe opens on at rotation 0; none for a block. A pipe that sets flow takes it in at the first and out at the second. */
  ends: readonly SketchPieceEdge[];
  /** Whether the piece decides its run's direction. A pipe that does not takes its run's. */
  setsFlow: boolean;
}

export const SKETCH_PIECE_CATALOG: readonly SketchPieceCatalogEntry[] = [
  { id: "block.cube", title: "Cube", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: true, carriesText: false, ends: [], setsFlow: false },
  { id: "block.ramp", title: "Ramp", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false },
  { id: "block.cylinder", title: "Cylinder", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: true, carriesText: false, ends: [], setsFlow: false },
  { id: "block.road", title: "Road", footprint: [1, 1], levels: 1, height: 0.1, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false },
  { id: "block.wall", title: "Wall", footprint: [1, 1], levels: 2, height: 2, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false },
  { id: "block.label", title: "Label", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: false, carriesText: true, ends: [], setsFlow: false },
  { id: "block.pipe", title: "Pipe", footprint: [1, 1], levels: 1, height: 0.5, stacksOnTop: false, carriesText: false, ends: ["front", "back"], setsFlow: true },
  { id: "block.pipe-angle", title: "Angle Pipe", footprint: [1, 1], levels: 1, height: 0.5, stacksOnTop: false, carriesText: false, ends: ["front", "right"], setsFlow: false }
];

// A stored id this build does not know, such as one a newer build wrote,
// keeps its record and counts as one level that nothing stacks on.
export const SKETCH_UNKNOWN_PIECE_ENTRY: SketchPieceCatalogEntry = {
  id: "",
  title: "Unknown piece",
  footprint: [1, 1],
  levels: 1,
  height: 1,
  stacksOnTop: false,
  carriesText: false,
  ends: [],
  setsFlow: false
};

export function findSketchPieceEntry(catalogId: string): SketchPieceCatalogEntry | undefined {
  return SKETCH_PIECE_CATALOG.find((entry) => entry.id === catalogId);
}

export function sketchPieceEntry(catalogId: string): SketchPieceCatalogEntry {
  return findSketchPieceEntry(catalogId) ?? SKETCH_UNKNOWN_PIECE_ENTRY;
}
