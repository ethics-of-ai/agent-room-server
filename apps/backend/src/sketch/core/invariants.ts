import {
  SKETCH_COORDINATE_LIMIT,
  SKETCH_MAX_GROUP_DEPTH,
  SKETCH_MAX_OBJECTS,
  SKETCH_MAX_PATTERN_SEGMENTS,
  SKETCH_MAX_SHAPE_SEGMENTS,
  SKETCH_MAX_TOTAL_POINTS,
  SKETCH_ELLIPSE_SEGMENTS
} from "./limits";
import {
  boxCorners,
  indexSketchObjects,
  isWithinSketchCube,
  readParentId,
  transformPoint,
  worldTransformOf,
  type ObjectIndex,
  type Vec3
} from "./geometry";
import {
  sketchObjectIdPattern,
  isKnownSketchObject,
  type SketchObject,
  type SketchTextBoxObject
} from "./schemas";
import type { SketchTextBoxAppearance } from "./textBoxSchemas";
import { checkTextBoxFormat, checkTotalExtrudedText } from "./textBoxFormat";

// Document-level invariants: everything that spans objects. The evaluator
// runs this after every operation so a refusal names the operation at fault,
// and the parse entry points run it so nothing structurally broken is ever
// accepted from storage. First violation wins; the message is caller-facing
// prose, the kind drives the typed error code.

export type SketchInvariantKind =
  | "duplicate_id"
  | "object_count"
  | "parent_reference"
  | "cycle"
  | "group_depth"
  | "total_points"
  | "pattern_segments"
  | "shape_segments"
  | "text_format"
  | "extruded_text_characters"
  | "total_extruded_text_characters"
  | "world_bounds";

export interface SketchInvariantIssue {
  kind: SketchInvariantKind;
  message: string;
  objectId?: string;
}

export function checkSketchObjects(objects: SketchObject[]): SketchInvariantIssue | null {
  if (objects.length > SKETCH_MAX_OBJECTS) {
    return {
      kind: "object_count",
      message: `A sketch may hold at most ${SKETCH_MAX_OBJECTS} objects (got ${objects.length})`
    };
  }

  const index = indexSketchObjects(objects);
  const seen = new Set<string>();
  for (const object of objects) {
    if (seen.has(object.id)) {
      return {
        kind: "duplicate_id",
        objectId: object.id,
        message: `Duplicate object id "${object.id}"`
      };
    }
    seen.add(object.id);
  }

  const issue = checkParentStructure(index);
  if (issue !== null) {
    return issue;
  }

  let totalPoints = 0;
  for (const object of objects) {
    if (isKnownSketchObject(object) && object.kind === "stroke") {
      totalPoints += object.points.length;
    }
  }
  if (totalPoints > SKETCH_MAX_TOTAL_POINTS) {
    return {
      kind: "total_points",
      message: `A sketch may hold at most ${SKETCH_MAX_TOTAL_POINTS} stroke points in total (got ${totalPoints})`
    };
  }

  let patternSegments = 0;
  for (const object of objects) {
    if (!isKnownSketchObject(object) || object.kind !== "stroke" || object.lineStyle === "solid") continue;
    const period = object.width * (object.lineStyle === "dashed" ? 7 : 3);
    let length = 0;
    for (let index = 1; index < object.points.length; index += 1) {
      const previous = object.points[index - 1];
      const current = object.points[index];
      length += Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]);
    }
    patternSegments += Math.ceil(length / period);
    if (patternSegments > SKETCH_MAX_PATTERN_SEGMENTS) {
      return {
        kind: "pattern_segments",
        message: `Patterned strokes may generate at most ${SKETCH_MAX_PATTERN_SEGMENTS} mesh segments in a sketch`
      };
    }
  }

  let shapeSegments = 0;
  for (const object of objects) {
    if (!isKnownSketchObject(object) || (object.kind !== "planarShape" && object.kind !== "textBox")) continue;
    const polygonSegments = object.kind === "textBox"
      ? 4
      : object.shapeType === "ellipse" ? SKETCH_ELLIPSE_SEGMENTS
        : object.shapeType === "rectangle" ? 4 : 3;
    const passes = (object.appearance === "fill" || object.appearance === "fillAndOutline" ? 1 : 0)
      + (object.appearance === "outline" || object.appearance === "fillAndOutline" ? 1 : 0);
    shapeSegments += polygonSegments * passes;
    if (shapeSegments > SKETCH_MAX_SHAPE_SEGMENTS) {
      return {
        kind: "shape_segments",
        message: `Planar shapes and text boxes may generate at most ${SKETCH_MAX_SHAPE_SEGMENTS} polygon segments in a sketch`
      };
    }
  }

  const textBoxes = objects.filter((object): object is SketchTextBoxObject =>
    isKnownSketchObject(object) && object.kind === "textBox");
  for (const textBox of textBoxes) {
    const formatIssue = checkTextBoxFormat(textBox);
    if (formatIssue !== null) {
      return { ...formatIssue, objectId: textBox.id };
    }
  }
  return checkTotalExtrudedText(textBoxes) ?? checkWorldBounds(index);
}

// Parent links must resolve to existing objects, never to the object itself,
// never form a cycle, and never nest groups deeper than the documented four
// levels. Depth counts ancestors regardless of their kind so an unknown-kind
// container cannot smuggle in unbounded nesting.
function checkParentStructure(index: ObjectIndex): SketchInvariantIssue | null {
  for (const object of index.objects) {
    const raw = (object as { parentId?: unknown }).parentId;
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" || !sketchObjectIdPattern.test(raw)) {
      return {
        kind: "parent_reference",
        objectId: object.id,
        message: `Object "${object.id}" has a malformed parent id`
      };
    }
    if (raw === object.id) {
      return {
        kind: "cycle",
        objectId: object.id,
        message: `Object "${object.id}" cannot be its own parent`
      };
    }
    if (!index.byId.has(raw)) {
      return {
        kind: "parent_reference",
        objectId: object.id,
        message: `Object "${object.id}" references unknown parent "${raw}"`
      };
    }

    const ancestors: string[] = [];
    const visited = new Set<string>([object.id]);
    let currentId: string | undefined = raw;
    while (currentId !== undefined) {
      if (visited.has(currentId)) {
        return {
          kind: "cycle",
          objectId: object.id,
          message: `Object "${object.id}" sits in a parent cycle at "${currentId}"`
        };
      }
      visited.add(currentId);
      ancestors.push(currentId);
      const node = index.byId.get(currentId);
      currentId = node === undefined ? undefined : readParentId(node);
    }
    if (ancestors.length > SKETCH_MAX_GROUP_DEPTH) {
      return {
        kind: "group_depth",
        objectId: object.id,
        message: `Object "${object.id}" is nested ${ancestors.length} group levels deep (max ${SKETCH_MAX_GROUP_DEPTH})`
      };
    }
  }
  return null;
}

// Raw object-local coordinates are schema-bounded to the 10 m cube; this
// check closes the composed escape — a transform (or a parent's transform)
// must not carry geometry outside the cube either. Strokes check every
// point, boxes all eight corners, and text, groups, and unknown-kind
// objects their anchor.
function checkWorldBounds(index: ObjectIndex): SketchInvariantIssue | null {
  for (const object of index.objects) {
    const world = worldTransformOf(object, index);
    const local: Vec3[] =
      isKnownSketchObject(object) && object.kind === "stroke"
        ? object.points
        : isKnownSketchObject(object) && object.kind === "box"
          ? boxCorners(object.size)
        : isKnownSketchObject(object) && object.kind === "planarShape"
            ? planarBoundsCorners(object, 0)
        : isKnownSketchObject(object) && object.kind === "textBox"
            ? planarBoundsCorners(object, object.rendering === "extruded" ? object.extrusionDepth / 2 : 0)
          : [[0, 0, 0]];
    for (const point of local) {
      const worldPoint = transformPoint(world, point);
      if (!isWithinSketchCube(worldPoint)) {
        const axisIndex = Math.max(
          0,
          worldPoint.findIndex((component) => Math.abs(component) > SKETCH_COORDINATE_LIMIT)
        );
        return {
          kind: "world_bounds",
          objectId: object.id,
          message: `Object "${object.id}" reaches ${worldPoint[axisIndex].toFixed(3)} m on the ${["x", "y", "z"][axisIndex]} axis; composed geometry must stay within ±${SKETCH_COORDINATE_LIMIT} m of the sketch origin`
        };
      }
    }
  }
  return null;
}

// Extruded text sits centered on the panel plane, so half its depth reaches
// out on each side.
function planarBoundsCorners(object: {
  size: [number, number];
  appearance: SketchTextBoxAppearance;
  outlineWidth: number;
}, halfExtrusion: number): Vec3[] {
  const outlined = object.appearance === "outline" || object.appearance === "fillAndOutline";
  const margin = outlined ? object.outlineWidth / 2 : 0;
  const halfWidth = object.size[0] / 2 + margin;
  const halfHeight = object.size[1] / 2 + margin;
  const halfDepth = Math.max(outlined ? margin : 0, 0.0005, halfExtrusion);
  return [
    [-halfWidth, -halfHeight, -halfDepth],
    [halfWidth, -halfHeight, -halfDepth],
    [-halfWidth, halfHeight, -halfDepth],
    [halfWidth, halfHeight, -halfDepth],
    [-halfWidth, -halfHeight, halfDepth],
    [halfWidth, -halfHeight, halfDepth],
    [-halfWidth, halfHeight, halfDepth],
    [halfWidth, halfHeight, halfDepth]
  ];
}
