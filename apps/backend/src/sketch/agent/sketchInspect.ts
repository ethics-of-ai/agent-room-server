import {
  resolveSketchTable,
  SKETCH_PIECE_CATALOG,
  SKETCH_PIECE_MAX_LEVELS,
  indexSketchObjects,
  sketchObjectExtentPoints,
  subtreeOf,
  transformPoint,
  worldTransformOf,
  resolveSketchTransform,
  sketchPipeRuns,
  type SketchDocument,
  type SketchObject
} from "../core";
import { readParentId } from "../core/geometry";
import { isKnownSketchObject } from "../core/schemas";

/**
 * What an agent reads about a sketch: a header with the coordinate
 * convention and one compact JSON line per object. Strokes report their point
 * count, never their points, and text is cut to an excerpt. Full objects come
 * back only for ids the agent names in `detail`.
 *
 * Every result stays under {@link SKETCH_TOOL_RESULT_BYTES}, below the
 * dispatcher's blind 64 KiB truncation, and says what it left out.
 */

export const SKETCH_TOOL_RESULT_BYTES = 48 * 1024;
const TEXT_EXCERPT_CHARACTERS = 80;

export const SKETCH_COORDINATE_CONVENTION =
  "Units are metres. Axes are right-handed: x right, y up, z toward the viewer. " +
  "A transform is translation t [x,y,z], rotation r as a unit quaternion [x,y,z,w], and scale s [x,y,z], relative to the parent group. " +
  "A transform operation replaces all three, so send r and s unchanged when you only move an object. " +
  "Bounds are world-space [[minX,minY,minZ],[maxX,maxY,maxZ]]. Geometry must stay within ±500 m of the origin. " +
  "Planar shapes and text boxes lie in their local XY plane. " +
  "Pieces stand on the table, a square board on the y = 0 plane whose width in cells and cellSize inspect reports. " +
  "The table is the whole board, and no piece can leave it. In cell [c,r], c and r run from 0 to one less than the width, and " +
  "cell [c,r] has its centre at " +
  "x = (c + 0.5) × cellSize and z = (r + 0.5) × cellSize, and level l starts at y = l × cellSize. A piece has no transform and no parent.";

/** One line per catalog entry, for the tool text and the inspect header. */
export const SKETCH_PIECE_CATALOG_SUMMARY =
  "Pieces: " + SKETCH_PIECE_CATALOG.map((entry) =>
    `${entry.id} (${entry.levels === 1 ? "1 level" : `${entry.levels} levels`}` +
    `${entry.stacksOnTop ? ", carries pieces" : ""}${entry.carriesText ? ", carries text" : ""}${entry.ends.length > 0 ? ", pipe" : ""})`
  ).join(", ") + `. A column holds ${SKETCH_PIECE_MAX_LEVELS} levels. Only a piece that carries text takes text.`;

export interface InspectedSketch {
  path: string;
  title: string;
  sketchId: string;
  revision: number;
  document: SketchDocument;
}

function tableLine(document: SketchDocument): string {
  const table = resolveSketchTable(document.table);
  const size = `${table.cells} by ${table.cells} cells of ${table.cellSize} m, columns and rows 0 to ${table.cells - 1}`;
  return document.table === undefined ? `No table is set, so the default table is ${size}.` : `The table is ${size}.`;
}

export function formatSketchInspection(sketch: InspectedSketch, detail: readonly string[] = []): string {
  const header = [
    `Sketch "${sketch.title}" at ${sketch.path}, id ${sketch.sketchId}, revision ${sketch.revision}, ${sketch.document.objects.length} object(s).`,
    `Pass revision ${sketch.revision} as baseRevision to edit.`,
    SKETCH_COORDINATE_CONVENTION,
    tableLine(sketch.document)
  ];
  const lines = compactObjectLines(sketch.document);
  const detailLines: string[] = [];
  const omittedDetail: string[] = [];
  const unknownDetail: string[] = [];
  const byId = new Map(sketch.document.objects.map((object) => [object.id, object]));
  for (const id of new Set(detail)) {
    const object = byId.get(id);
    if (object === undefined) unknownDetail.push(id);
    else detailLines.push(JSON.stringify(object));
  }

  // Detail is what the agent asked for by name, so it gets the budget first;
  // the compact list fills what is left.
  let budget = SKETCH_TOOL_RESULT_BYTES - bytes(header.join("\n")) - 512;
  const keptDetail: string[] = [];
  for (const [index, line] of detailLines.entries()) {
    if (bytes(line) + 1 > budget) {
      omittedDetail.push(...[...new Set(detail)].filter((id) => byId.has(id)).slice(index));
      break;
    }
    keptDetail.push(line);
    budget -= bytes(line) + 1;
  }
  // Runs come next: a run is one short line that no object line repeats,
  // and the objects can be read again by id.
  const runLines = pipeRunLines(sketch.document);
  const runHeading = runLines.length > 0 ? [PIPE_RUNS_HEADING] : [];
  budget -= runHeading.reduce((sum, line) => sum + bytes(line) + 1, 0);
  const keptRuns = keepWithin(runLines, budget);
  budget -= keptRuns.reduce((sum, line) => sum + bytes(line) + 1, 0);
  const keptLines = keepWithin(lines, budget);

  const out = [...header, "Objects, one JSON line each:", ...keptLines];
  if (keptLines.length < lines.length) {
    out.push(`(${lines.length - keptLines.length} more object(s) left out to stay within the result limit.)`);
  }
  out.push(...runHeading, ...keptRuns);
  if (keptRuns.length < runLines.length) {
    out.push(`(${runLines.length - keptRuns.length} more pipe run(s) left out to stay within the result limit.)`);
  }
  if (detail.length > 0) {
    out.push("Full detail for the requested ids:", ...keptDetail);
    if (omittedDetail.length > 0) out.push(`(Detail left out to stay within the result limit: ${omittedDetail.join(", ")}. Ask for fewer ids.)`);
    if (unknownDetail.length > 0) out.push(`(No object with id: ${unknownDetail.join(", ")}.)`);
  }
  return out.join("\n");
}

const PIPE_RUNS_HEADING =
  "Pipe runs, one JSON line each: pipes in order, in flow order when the run flows; ends, what the first and last pipe meet " +
  "(a piece id, or null for an open end), or loop true for a run that closes on itself; flow, which is flows, none (no block.pipe in the run) or conflict; " +
  "and conflicts, pairs of block.pipe pieces that point against each other.";

/** One line per pipe run, in the order runs first appear in the document. */
function pipeRunLines(document: SketchDocument): string[] {
  return sketchPipeRuns(document.objects).map((run) => JSON.stringify({
    pipes: run.pipeIds,
    ...(run.loop ? { loop: true } : { ends: run.ends }),
    flow: run.flow,
    ...(run.conflicts.length > 0 ? { conflicts: run.conflicts } : {})
  }));
}

/** The leading lines that fit in `budget` bytes, one newline each. */
function keepWithin(lines: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    if (bytes(line) + 1 > budget) break;
    kept.push(line);
    budget -= bytes(line) + 1;
  }
  return kept;
}

/** The compact line for each object, in document order. */
export function compactObjectLines(document: SketchDocument, only?: ReadonlySet<string>): string[] {
  const index = indexSketchObjects(document.objects);
  return document.objects
    .filter((object) => only === undefined || only.has(object.id))
    .map((object) => JSON.stringify(compactObject(object, index)));
}

function compactObject(object: SketchObject, index: ReturnType<typeof indexSketchObjects>): Record<string, unknown> {
  const transform = resolveSketchTransform((object as { transform?: Parameters<typeof resolveSketchTransform>[0] }).transform);
  const parent = readParentId(object);
  const line: Record<string, unknown> = {
    id: object.id,
    kind: object.kind,
    ...(parent ? { parent } : {}),
    // Always all three: a transform operation replaces the whole transform,
    // so the agent copies the parts it keeps from here.
    t: transform.translation.map(round),
    r: transform.rotation.map(round),
    s: transform.scale.map(round),
    bounds: worldBounds(object, index)
  };
  if (!isKnownSketchObject(object)) return { ...line, editable: false };
  switch (object.kind) {
    case "stroke":
      return { ...line, points: object.points.length, width: object.width, brush: object.brush, lineStyle: object.lineStyle, ...color(object.color) };
    case "box":
      return { ...line, size: object.size, ...color(object.color) };
    case "text":
      return { ...line, text: excerpt(object.text), ...color(object.color) };
    case "planarShape":
      return { ...line, shapeType: object.shapeType, size: object.size, appearance: object.appearance,
        fillColor: object.fillColor, outlineColor: object.outlineColor };
    case "textBox":
      return { ...line, text: excerpt(object.text), size: object.size, appearance: object.appearance,
        fillColor: object.fillColor, outlineColor: object.outlineColor, ...color(object.color),
        fontSize: object.font.size, rendering: object.rendering };
    case "group":
      return { ...line, members: index.objects.filter((candidate) => readParentId(candidate) === object.id).length };
    case "piece":
      return { id: object.id, kind: object.kind, catalogId: object.catalogId, cell: object.cell, level: object.level,
        rotation: object.rotation, ...color(object.color), ...(object.text === undefined ? {} : { text: excerpt(object.text) }) };
  }
}

function worldBounds(object: SketchObject, index: ReturnType<typeof indexSketchObjects>): number[][] {
  // A group's bounds cover the non-group objects under it; an empty group
  // reports its anchor.
  const subtree = object.kind === "group" ? subtreeOf(object.id, index) : [object];
  const geometry = subtree.filter((member) => member.kind !== "group");
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const member of geometry.length > 0 ? geometry : [object]) {
    const world = worldTransformOf(member, index);
    for (const point of sketchObjectExtentPoints(member)) {
      const position = transformPoint(world, point);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], position[axis]);
        max[axis] = Math.max(max[axis], position[axis]);
      }
    }
  }
  return [min.map(round), max.map(round)];
}

function color(value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { color: value };
}

function excerpt(text: string): string {
  const characters = [...text];
  return characters.length <= TEXT_EXCERPT_CHARACTERS ? text : `${characters.slice(0, TEXT_EXCERPT_CHARACTERS).join("")}…`;
}

/** Tenth-of-a-millimetre precision keeps lines short without hiding placement. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
