import { SKETCH_PIECE_EDGES, findSketchPieceEntry, sketchPieceEntry, type SketchPieceEdge } from "./pieceCatalog";
import { isSketchPiece } from "./pieceRules";
import type { SketchPieceObject } from "./pieceSchemas";

// Pipe runs, read from where pipes sit and how they are turned. Nothing here
// is stored or refused: inspect reports runs and the client draws them.
// `apps/visionos/AgentRoom/State/Sketch/SketchPipeRuns.swift` is the client's
// copy, and `test/fixtures/sketchPipeRunCases.json` runs one set of cases
// through both. The rules are in docs/api/API.md under "Pipe runs".
//
// A pipe is a known entry with ends. Every pipe in the catalog has two, so a
// run is a line or a loop; a pipe with more ends needs these rules extended.

interface ObjectLike {
  id: string;
  kind: string;
}

export type SketchPipeFlow = "flows" | "none" | "conflict";

export interface SketchPipeRun {
  /** Pipe ids in walk order. When the run flows, the walk follows the flow. */
  pipeIds: string[];
  loop: boolean;
  /**
   * What the line's first and last pipe meet: a piece id, or null for an open
   * end. Empty for a loop.
   */
  ends: (string | null)[];
  flow: SketchPipeFlow;
  /** Neighbouring straight pipes, angle pipes between them aside, that point against each other. */
  conflicts: [string, string][];
}

const EDGE_STEPS: Record<SketchPieceEdge, [number, number]> = {
  back: [0, -1],
  right: [1, 0],
  front: [0, 1],
  left: [-1, 0]
};

/** The edge `edge` becomes after `quarterTurns` clockwise seen from above. */
export function turnedSketchPieceEdge(edge: SketchPieceEdge, quarterTurns: number): SketchPieceEdge {
  const index = SKETCH_PIECE_EDGES.indexOf(edge) + quarterTurns;
  return SKETCH_PIECE_EDGES[((index % 4) + 4) % 4];
}

/** A pipe's ends after its turn, in catalog order; empty for a block or an unknown id. */
function pipeEnds(piece: SketchPieceObject): SketchPieceEdge[] {
  return (findSketchPieceEntry(piece.catalogId)?.ends ?? []).map((edge) => turnedSketchPieceEdge(edge, piece.rotation));
}

/** The end a walk leaves `pipe` by after entering at `entry`. */
function exitOf(pipe: SketchPieceObject, entry: SketchPieceEdge): SketchPieceEdge {
  return pipeEnds(pipe).find((edge) => edge !== entry) ?? entry;
}

/** A pipe on a walk and the end the walk enters it by. */
interface PipeStep {
  pipe: SketchPieceObject;
  entry: SketchPieceEdge;
}

type EndMeets = { pipe: SketchPieceObject } | { pieceId: string } | null;

export function sketchPipeRuns(objects: readonly ObjectLike[]): SketchPipeRun[] {
  const pieces = objects.filter(isSketchPiece);
  const pipes = pieces.filter((piece) => pipeEnds(piece).length === 2);
  const pipeAt = new Map(pipes.map((pipe) => [`${pipe.cell[0]},${pipe.cell[1]},${pipe.level}`, pipe]));
  const columns = new Map<string, SketchPieceObject[]>();
  for (const piece of pieces) {
    const key = `${piece.cell[0]},${piece.cell[1]}`;
    columns.set(key, [...(columns.get(key) ?? []), piece]);
  }

  function meets(pipe: SketchPieceObject, edge: SketchPieceEdge): EndMeets {
    const [dc, dr] = EDGE_STEPS[edge];
    const cell = [pipe.cell[0] + dc, pipe.cell[1] + dr];
    const neighbour = pipeAt.get(`${cell[0]},${cell[1]},${pipe.level}`);
    if (neighbour !== undefined) {
      return pipeEnds(neighbour).includes(turnedSketchPieceEdge(edge, 2)) ? { pipe: neighbour } : null;
    }
    // A piece without ends that fills the pipe's level ends the run there.
    const block = (columns.get(`${cell[0]},${cell[1]}`) ?? []).find((piece) =>
      pipeEnds(piece).length === 0 &&
      piece.level <= pipe.level && pipe.level < piece.level + sketchPieceEntry(piece.catalogId).levels);
    return block === undefined ? null : { pieceId: block.id };
  }

  const visited = new Set<string>();
  const runs: SketchPipeRun[] = [];
  for (const seed of pipes) {
    if (visited.has(seed.id)) continue;
    const start = lineStart(seed, meets) ?? loopStart(seed, meets);
    runs.push(walk(start.pipe, start.entry, meets, visited));
  }
  return runs;
}

type Meets = (pipe: SketchPieceObject, edge: SketchPieceEdge) => EndMeets;

/** A pipe at one end of the seed's line and the end it starts from, or null when the seed is in a loop. */
function lineStart(seed: SketchPieceObject, meets: Meets): PipeStep | null {
  const seen = new Set<string>();
  let pipe = seed;
  let entry = pipeEnds(seed)[0];
  while (!seen.has(pipe.id)) {
    seen.add(pipe.id);
    // Walk backward out of the entry end until it meets no pipe.
    const met = meets(pipe, entry);
    if (met === null || !("pipe" in met)) return { pipe, entry };
    const back = turnedSketchPieceEdge(entry, 2);
    pipe = met.pipe;
    entry = exitOf(pipe, back);
  }
  return null;
}

/** A loop starts at its lowest pipe id, entering at that pipe's first end, so every run of the same pipes reads alike. */
function loopStart(seed: SketchPieceObject, meets: Meets): PipeStep {
  let lowest = seed;
  let pipe = seed;
  let exit = pipeEnds(seed)[1];
  for (;;) {
    const met = meets(pipe, exit);
    if (met === null || !("pipe" in met) || met.pipe.id === seed.id) return { pipe: lowest, entry: pipeEnds(lowest)[0] };
    const entry = turnedSketchPieceEdge(exit, 2);
    pipe = met.pipe;
    exit = exitOf(pipe, entry);
    if (pipe.id < lowest.id) lowest = pipe;
  }
}

function walk(start: SketchPieceObject, startEntry: SketchPieceEdge, meets: Meets, visited: Set<string>): SketchPipeRun {
  const steps: PipeStep[] = [];
  let pipe = start;
  let entry = startEntry;
  let loop = false;
  let last: EndMeets = null;
  for (;;) {
    visited.add(pipe.id);
    steps.push({ pipe, entry });
    const exit = exitOf(pipe, entry);
    const met = meets(pipe, exit);
    if (met !== null && "pipe" in met) {
      if (met.pipe.id === start.id) {
        loop = true;
        break;
      }
      entry = turnedSketchPieceEdge(exit, 2);
      pipe = met.pipe;
      continue;
    }
    last = met;
    break;
  }

  // +1 where a straight pipe takes flow in where the walk enters it, -1 against.
  const signs = steps.flatMap(({ pipe: step, entry: stepEntry }) =>
    sketchPieceEntry(step.catalogId).setsFlow ? [{ id: step.id, sign: pipeEnds(step)[0] === stepEntry ? 1 : -1 }] : []);
  const conflicts: [string, string][] = [];
  const pairs = signs.map((sign, index) => [sign, signs[index + 1] ?? (loop ? signs[0] : undefined)] as const);
  for (const [a, b] of pairs) {
    if (b === undefined || a.id === b.id || a.sign === b.sign) continue;
    if (!conflicts.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id))) conflicts.push([a.id, b.id]);
  }
  const flow: SketchPipeFlow = signs.length === 0 ? "none" : conflicts.length > 0 ? "conflict" : "flows";

  const first = meets(start, startEntry);
  let pipeIds = steps.map((step) => step.pipe.id);
  let ends = loop ? [] : [endId(first), endId(last)];
  if (flow === "flows" && signs[0].sign < 0) {
    pipeIds = loop ? [pipeIds[0], ...pipeIds.slice(1).reverse()] : pipeIds.reverse();
    ends = ends.reverse();
  }
  return { pipeIds, loop, ends, flow, conflicts };
}

function endId(met: EndMeets): string | null {
  return met !== null && "pieceId" in met ? met.pieceId : null;
}
