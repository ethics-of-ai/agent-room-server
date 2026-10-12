import {
  indexSketchObjects,
  sketchObjectExtentPoints,
  subtreeOf,
  transformPoint,
  worldTransformOf,
  resolveSketchTransform,
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
  "Planar shapes and text boxes lie in their local XY plane.";

export interface InspectedSketch {
  path: string;
  title: string;
  sketchId: string;
  revision: number;
  document: SketchDocument;
}

export function formatSketchInspection(sketch: InspectedSketch, detail: readonly string[] = []): string {
  const header = [
    `Sketch "${sketch.title}" at ${sketch.path}, id ${sketch.sketchId}, revision ${sketch.revision}, ${sketch.document.objects.length} object(s).`,
    `Pass revision ${sketch.revision} as baseRevision to edit.`,
    SKETCH_COORDINATE_CONVENTION
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
  const keptLines: string[] = [];
  for (const line of lines) {
    if (bytes(line) + 1 > budget) break;
    keptLines.push(line);
    budget -= bytes(line) + 1;
  }

  const out = [...header, "Objects, one JSON line each:", ...keptLines];
  if (keptLines.length < lines.length) {
    out.push(`(${lines.length - keptLines.length} more object(s) left out to stay within the result limit.)`);
  }
  if (detail.length > 0) {
    out.push("Full detail for the requested ids:", ...keptDetail);
    if (omittedDetail.length > 0) out.push(`(Detail left out to stay within the result limit: ${omittedDetail.join(", ")}. Ask for fewer ids.)`);
    if (unknownDetail.length > 0) out.push(`(No object with id: ${unknownDetail.join(", ")}.)`);
  }
  return out.join("\n");
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
