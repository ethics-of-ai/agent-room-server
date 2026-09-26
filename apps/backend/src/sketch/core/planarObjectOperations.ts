import { SKETCH_DEFAULT_EXTRUSION_DEPTH, SKETCH_DEFAULT_TEXT_FONT_SIZE } from "./limits";
import type {
  KnownSketchObject,
  SketchCallerOperation,
  SketchDocument,
  SketchOperation,
  SketchTransform
} from "./schemas";
import type { SketchCoreError } from "./errors";
import { SKETCH_TEXT_BOX_FORMAT_KEYS } from "./textBoxSchemas";
import { defaultTextParagraphs } from "./textBoxFormat";

// Create and update for the planar kinds. Planar shapes and text boxes share
// size and appearance, so both replace those fields through one helper and
// record the prior values as their undo inverse. A text box create fills any
// formatting it leaves out with plain defaults; an update replaces the
// formatting fields it carries, and the invariants pass then checks the whole
// box against its text.

type PlanarObject = Extract<KnownSketchObject, { kind: "planarShape" | "textBox" }>;
type PlanarCreate = Extract<SketchCallerOperation, { op: "create"; kind: "planarShape" | "textBox" }>;
type PlanarUpdate = Extract<SketchCallerOperation, { op: "update"; kind: "planarShape" | "textBox" }>;
type Applied = { ok: true; inverse: SketchOperation[] } | { ok: false; error: SketchCoreError };

const PLANAR_APPEARANCE_KEYS = ["size", "appearance", "fillColor", "outlineColor", "outlineWidth"] as const;

export function applyPlanarCreate(
  document: SketchDocument,
  operation: PlanarCreate,
  transform: SketchTransform
): Applied {
  const appearance = {
    size: structuredClone(operation.size),
    appearance: operation.appearance,
    fillColor: operation.fillColor,
    outlineColor: operation.outlineColor,
    outlineWidth: operation.outlineWidth,
    transform: structuredClone(transform)
  };
  if (operation.kind === "textBox") {
    document.objects.push({
      id: operation.objectId,
      kind: "textBox",
      text: operation.text,
      ...(operation.color === undefined ? {} : { color: operation.color }),
      font: structuredClone(operation.font ?? { family: "system", size: SKETCH_DEFAULT_TEXT_FONT_SIZE }),
      paragraphs: structuredClone(operation.paragraphs ?? defaultTextParagraphs(operation.text)),
      spans: structuredClone(operation.spans ?? []),
      rendering: operation.rendering ?? "flat",
      extrusionDepth: operation.extrusionDepth ?? SKETCH_DEFAULT_EXTRUSION_DEPTH,
      ...appearance
    });
  } else {
    document.objects.push({
      id: operation.objectId,
      kind: "planarShape",
      shapeType: operation.shapeType,
      ...appearance
    });
  }
  return { ok: true, inverse: [{ op: "remove", objectIds: [operation.objectId] }] };
}

export function applyPlanarUpdate(object: PlanarObject, operation: PlanarUpdate): Applied {
  // Kind-specific fields first, so inverse operations keep the schema's field order.
  const previous: Record<string, unknown> = {};
  if (operation.kind === "planarShape" && object.kind === "planarShape") {
    Object.assign(previous, replaceFields(object, operation, ["shapeType"] as const));
  }
  if (operation.kind === "textBox" && object.kind === "textBox") {
    if (operation.text !== undefined && (operation.paragraphs === undefined || operation.spans === undefined)) {
      return {
        ok: false,
        error: {
          code: "invalid_operation",
          message: `An update that changes the text of "${operation.objectId}" must also carry its paragraphs and spans`
        }
      };
    }
    Object.assign(previous, replaceFields(object, operation, ["text"] as const));
    if (operation.color !== undefined) {
      previous.color = object.color ?? null;
      if (operation.color === null) delete object.color;
      else object.color = operation.color;
    }
  }
  Object.assign(previous, replaceFields(object, operation, PLANAR_APPEARANCE_KEYS));
  if (operation.kind === "textBox" && object.kind === "textBox") {
    Object.assign(previous, replaceFields(object, operation, SKETCH_TEXT_BOX_FORMAT_KEYS));
  }
  return {
    ok: true,
    inverse: [{ op: "update", objectId: operation.objectId, kind: operation.kind, ...previous } as SketchOperation]
  };
}

/** Replaces each named field the update carries and returns the values it replaced. */
function replaceFields<T extends object, K extends keyof T & string>(
  object: T,
  update: Partial<Record<K, unknown>>,
  keys: readonly K[]
): Partial<Pick<T, K>> {
  const previous: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    const value = update[key];
    if (value === undefined) continue;
    previous[key] = structuredClone(object[key]);
    object[key] = structuredClone(value) as T[K];
  }
  return previous;
}
