import { z } from "zod";
import {
  SKETCH_COORDINATE_LIMIT,
  SKETCH_DEFAULT_BRUSH,
  SKETCH_DEFAULT_LINE_STYLE,
  SKETCH_DEFAULT_OUTLINE_WIDTH,
  SKETCH_KNOWN_OBJECT_KINDS,
  SKETCH_MAX_BATCH_OPERATIONS,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_BOX_DIMENSION,
  SKETCH_MAX_OBJECTS,
  SKETCH_MAX_STROKE_POINTS,
  SKETCH_MAX_STROKE_WIDTH,
  SKETCH_MAX_OUTLINE_WIDTH,
  SKETCH_MAX_TEXT_CHARACTERS,
  SKETCH_MIN_DIMENSION,
  SKETCH_MIN_SCALE,
  SKETCH_MAX_SCALE,
  SKETCH_MIN_STROKE_POINTS,
  SKETCH_QUATERNION_NORM_TOLERANCE,
  SKETCH_SCHEMA_VERSION,
  type SketchKnownObjectKind
} from "./limits";
import { sketchTextBoxAppearanceSchema, textBoxFormatFields, textBoxFormatOptionalFields } from "./textBoxSchemas";

// Sketch document and operation contracts. Schemas own per-field validity:
// shapes, grammars, finite numbers, and scalar ranges. Checks that span
// objects (duplicate ids, parent links, cycles, depth, composed world
// bounds, point totals) live in `invariants.ts` and run through the
// evaluator and the parse entry points, never as ad-hoc zod refinements.
//
// Geometry is meters in a right-handed, y-up coordinate system centered on
// the sketch origin (x right, y up, z toward the viewer — RealityKit-native,
// like the spatial scene engine). Rotation is a normalized quaternion
// [x, y, z, w]; scale is positive per axis; translation is a point. Object
// geometry is stored in object-local space and placed by the object's
// transform composed with its parent chain.

// --- ids ---------------------------------------------------------------------

export const sketchIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
  message: "Sketch ids must match ^[a-z0-9][a-z0-9-]{0,63}$"
});
export const sketchObjectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const sketchObjectIdSchema = z.string().regex(sketchObjectIdPattern, {
  message: "Object ids must match ^[a-z0-9][a-z0-9_-]{0,63}$"
});
// Request ids are caller-minted idempotency keys; a wider grammar keeps
// client UUID spellings usable verbatim.
export const sketchRequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
  message: "Request ids must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
});
export const sketchTurnIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
  message: "Turn ids must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
});
export const sketchTransactionIdPattern = /^tx-[0-9]+$/;

// --- scalars and geometry fields ----------------------------------------------

const finiteNumber = z.number().finite();
const coordinateComponent = finiteNumber
  .min(-SKETCH_COORDINATE_LIMIT)
  .max(SKETCH_COORDINATE_LIMIT);
const coordinateVec3 = z.tuple([coordinateComponent, coordinateComponent, coordinateComponent]);
const strokeWidthSchema = finiteNumber.min(SKETCH_MIN_DIMENSION).max(SKETCH_MAX_STROKE_WIDTH);
const boxDimensionSchema = finiteNumber.min(SKETCH_MIN_DIMENSION).max(SKETCH_MAX_BOX_DIMENSION);
const planarSizeSchema = z.tuple([boxDimensionSchema, boxDimensionSchema]);
const outlineWidthSchema = finiteNumber.min(SKETCH_MIN_DIMENSION).max(SKETCH_MAX_OUTLINE_WIDTH);
const textSchema = z.string().min(1).max(SKETCH_MAX_TEXT_CHARACTERS);
export const sketchColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: "Colors must be #RRGGBB or #RRGGBBAA"
  });
export const sketchBrushSchema = z.enum(["finePen", "broadMarker", "highlighter"]);
export const sketchLineStyleSchema = z.enum(["solid", "dashed", "dotted"]);
export const sketchPlanarShapeTypeSchema = z.enum(["rectangle", "ellipse", "triangle"]);
export const sketchShapeAppearanceSchema = z.enum(["outline", "fill", "fillAndOutline"]);

// Planar shapes and text boxes share one bounded size and appearance. The
// stored and create forms require every part; updates replace any subset.
const planarAppearanceFields = {
  size: planarSizeSchema,
  appearance: sketchShapeAppearanceSchema,
  fillColor: sketchColorSchema,
  outlineColor: sketchColorSchema,
  outlineWidth: outlineWidthSchema.default(SKETCH_DEFAULT_OUTLINE_WIDTH)
} as const;
const planarAppearanceUpdateFields = {
  size: planarSizeSchema.optional(),
  appearance: sketchShapeAppearanceSchema.optional(),
  fillColor: sketchColorSchema.optional(),
  outlineColor: sketchColorSchema.optional(),
  outlineWidth: outlineWidthSchema.optional()
} as const;

const strokePointsSchema = z
  .array(coordinateVec3)
  .min(SKETCH_MIN_STROKE_POINTS)
  .max(SKETCH_MAX_STROKE_POINTS);
const boxSizeSchema = z.tuple([boxDimensionSchema, boxDimensionSchema, boxDimensionSchema]);
const scaleComponentSchema = finiteNumber.min(SKETCH_MIN_SCALE).max(SKETCH_MAX_SCALE);

export const sketchTransformSchema = z
  .object({
    translation: coordinateVec3,
    rotation: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]),
    scale: z.tuple([scaleComponentSchema, scaleComponentSchema, scaleComponentSchema])
  })
  .strict()
  .superRefine((transform, context) => {
    const [qx, qy, qz, qw] = transform.rotation;
    const norm = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (Math.abs(norm - 1) > SKETCH_QUATERNION_NORM_TOLERANCE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Rotation quaternion must be normalized (|q| within ${SKETCH_QUATERNION_NORM_TOLERANCE} of 1, got ${norm})`,
        path: ["rotation"]
      });
    }
  });

// --- stored objects ------------------------------------------------------------

const parentIdSchema = sketchObjectIdSchema.optional();

export const sketchStrokeObjectSchema = z
  .object({
    id: sketchObjectIdSchema,
    kind: z.literal("stroke"),
    parentId: parentIdSchema,
    points: strokePointsSchema,
    width: strokeWidthSchema,
    brush: sketchBrushSchema,
    lineStyle: sketchLineStyleSchema,
    color: sketchColorSchema.optional(),
    transform: sketchTransformSchema.optional()
  })
  .strict();

export const sketchBoxObjectSchema = z
  .object({
    id: sketchObjectIdSchema,
    kind: z.literal("box"),
    parentId: parentIdSchema,
    size: boxSizeSchema,
    color: sketchColorSchema.optional(),
    transform: sketchTransformSchema.optional()
  })
  .strict();

export const sketchTextObjectSchema = z
  .object({
    id: sketchObjectIdSchema,
    kind: z.literal("text"),
    parentId: parentIdSchema,
    text: textSchema,
    color: sketchColorSchema.optional(),
    transform: sketchTransformSchema.optional()
  })
  .strict();

export const sketchPlanarShapeObjectSchema = z.object({
  id: sketchObjectIdSchema,
  kind: z.literal("planarShape"),
  parentId: parentIdSchema,
  shapeType: sketchPlanarShapeTypeSchema,
  ...planarAppearanceFields,
  transform: sketchTransformSchema.optional()
}).strict();

export const sketchTextBoxObjectSchema = z.object({
  id: sketchObjectIdSchema,
  kind: z.literal("textBox"),
  parentId: parentIdSchema,
  text: textSchema,
  color: sketchColorSchema.optional(),
  ...textBoxFormatFields,
  ...planarAppearanceFields,
  appearance: sketchTextBoxAppearanceSchema,
  transform: sketchTransformSchema.optional()
}).strict();

export const sketchGroupObjectSchema = z
  .object({
    id: sketchObjectIdSchema,
    kind: z.literal("group"),
    parentId: parentIdSchema,
    transform: sketchTransformSchema.optional()
  })
  .strict();

// Unknown kinds are preserved verbatim so an older reader retains objects a
// newer document kind introduced: every field survives storage round trips,
// and the evaluator refuses operations that target them directly (they can
// still be moved structurally by group membership, which is how forward
// compatibility avoids orphans). A malformed *known* kind never lands here —
// its literal fails the refinement below, so it surfaces as a parse error.
export const sketchUnknownObjectSchema = z
  .object({
    id: sketchObjectIdSchema,
    kind: z.string().min(1).max(64)
  })
  .passthrough()
  .superRefine((object, context) => {
    if ((SKETCH_KNOWN_OBJECT_KINDS as readonly string[]).includes(object.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Kind "${object.kind}" is a known kind and must match its strict schema`,
        path: ["kind"]
      });
    }
  });

export const sketchObjectSchema = z.union([
  sketchStrokeObjectSchema,
  sketchBoxObjectSchema,
  sketchTextObjectSchema,
  sketchPlanarShapeObjectSchema,
  sketchTextBoxObjectSchema,
  sketchGroupObjectSchema,
  sketchUnknownObjectSchema
]);

export const sketchDocumentSchema = z
  .object({
    schemaVersion: z.literal(SKETCH_SCHEMA_VERSION),
    kind: z.literal("sketch"),
    sketchId: sketchIdSchema,
    revision: z.number().int().min(0),
    objects: z.array(sketchObjectSchema).max(SKETCH_MAX_OBJECTS)
  })
  .strict();

// --- operations -----------------------------------------------------------------
//
// The caller vocabulary is exactly the six documented operations; the three
// `restore`/`remove`/`setParents` shapes are history-internal: they carry the
// exact prior state an undo reapplies, and they appear only inside stored
// history entries. Request schemas accept caller operations only.

const createCommon = {
  op: z.literal("create"),
  objectId: sketchObjectIdSchema,
  color: sketchColorSchema.optional(),
  transform: sketchTransformSchema.optional()
} as const;

// Each create and update member is exported on its own so the version-1
// reader can build its narrower unions from the same definitions.
export const sketchStrokeCreateSchema = z
  .object({
    ...createCommon,
    kind: z.literal("stroke"),
    points: strokePointsSchema,
    width: strokeWidthSchema,
    brush: sketchBrushSchema.default(SKETCH_DEFAULT_BRUSH),
    lineStyle: sketchLineStyleSchema.default(SKETCH_DEFAULT_LINE_STYLE)
  })
  .strict();
export const sketchBoxCreateSchema = z.object({ ...createCommon, kind: z.literal("box"), size: boxSizeSchema }).strict();
export const sketchTextCreateSchema = z.object({ ...createCommon, kind: z.literal("text"), text: textSchema }).strict();

export const sketchTextBoxCreateSchema = z.object({
  ...createCommon,
  kind: z.literal("textBox"),
  text: textSchema,
  ...textBoxFormatOptionalFields,
  ...planarAppearanceFields,
  appearance: sketchTextBoxAppearanceSchema
}).strict();
export const sketchPlanarShapeCreateSchema = z.object({
  op: z.literal("create"),
  objectId: sketchObjectIdSchema,
  kind: z.literal("planarShape"),
  shapeType: sketchPlanarShapeTypeSchema,
  ...planarAppearanceFields,
  transform: sketchTransformSchema.optional()
}).strict();

export const sketchCreateOperationSchema = z.union([
  sketchStrokeCreateSchema,
  sketchBoxCreateSchema,
  sketchTextCreateSchema,
  sketchTextBoxCreateSchema,
  sketchPlanarShapeCreateSchema
]);

const updateCommon = {
  op: z.literal("update"),
  objectId: sketchObjectIdSchema
} as const;

// An update names the fields it replaces; one with nothing to replace is
// refused rather than recorded as an empty history entry.
export function requireUpdateField<T extends z.ZodRawShape>(schema: z.ZodObject<T, "strict">) {
  return schema.refine(
    (op) => Object.entries(op).some(([key, value]) =>
      key !== "op" && key !== "objectId" && key !== "kind" && value !== undefined),
    { message: "An update must carry at least one field" }
  );
}

export const sketchStrokeUpdateFields = {
  ...updateCommon,
  kind: z.literal("stroke"),
  points: strokePointsSchema.optional(),
  width: strokeWidthSchema.optional(),
  color: sketchColorSchema.nullable().optional()
} as const;
export const sketchBoxUpdateSchema = requireUpdateField(z.object({
  ...updateCommon,
  kind: z.literal("box"),
  size: boxSizeSchema.optional(),
  color: sketchColorSchema.nullable().optional()
}).strict());
export const sketchTextUpdateSchema = requireUpdateField(z.object({
  ...updateCommon,
  kind: z.literal("text"),
  text: textSchema.optional(),
  color: sketchColorSchema.nullable().optional()
}).strict());

export const sketchStrokeStyleUpdateSchema = requireUpdateField(z.object({
  ...sketchStrokeUpdateFields,
  brush: sketchBrushSchema.optional(),
  lineStyle: sketchLineStyleSchema.optional()
}).strict());
export const sketchPlanarShapeUpdateSchema = requireUpdateField(z.object({
  ...updateCommon,
  kind: z.literal("planarShape"),
  shapeType: sketchPlanarShapeTypeSchema.optional(),
  ...planarAppearanceUpdateFields
}).strict());
export const sketchTextBoxUpdateFields = {
  ...updateCommon,
  kind: z.literal("textBox"),
  text: textSchema.optional(),
  color: sketchColorSchema.nullable().optional(),
  ...planarAppearanceUpdateFields,
  appearance: sketchTextBoxAppearanceSchema.optional()
} as const;

// `color: null` clears a color; geometry fields replace wholesale when present.
// A text box update that changes `text` must also carry `paragraphs` and
// `spans`; the operation refuses it otherwise, so formatting never drifts
// from the text it describes.
export const sketchUpdateOperationSchema = z.union([
  sketchStrokeStyleUpdateSchema,
  sketchBoxUpdateSchema,
  sketchTextUpdateSchema,
  sketchPlanarShapeUpdateSchema,
  requireUpdateField(z.object({
    ...sketchTextBoxUpdateFields,
    ...textBoxFormatOptionalFields
  }).strict())
]);

export const sketchTransformOperationSchema = z
  .object({
    op: z.literal("transform"),
    objectId: sketchObjectIdSchema,
    transform: sketchTransformSchema
  })
  .strict();

// Deleting a group removes its whole subtree; the undo entry restores every
// removed object exactly.
export const sketchDeleteOperationSchema = z
  .object({
    op: z.literal("delete"),
    objectId: sketchObjectIdSchema
  })
  .strict();

// Clearing removes every object in one undoable step. Unknown-kind objects
// block it, so a clear never discards content this core cannot edit.
export const sketchClearOperationSchema = z
  .object({
    op: z.literal("clear")
  })
  .strict();

export const sketchGroupOperationSchema = z
  .object({
    op: z.literal("group"),
    groupId: sketchObjectIdSchema,
    memberIds: z.array(sketchObjectIdSchema).min(1).max(SKETCH_MAX_OBJECTS),
    parentId: sketchObjectIdSchema.optional()
  })
  .strict();

export const sketchUngroupOperationSchema = z
  .object({
    op: z.literal("ungroup"),
    groupId: sketchObjectIdSchema
  })
  .strict();

export const sketchRestoreOperationSchema = z
  .object({
    op: z.literal("restore"),
    objects: z.array(sketchObjectSchema).min(1).max(SKETCH_MAX_OBJECTS)
  })
  .strict();

export const sketchRemoveOperationSchema = z
  .object({
    op: z.literal("remove"),
    objectIds: z.array(sketchObjectIdSchema).min(1).max(SKETCH_MAX_OBJECTS)
  })
  .strict();

export const sketchSetParentsOperationSchema = z
  .object({
    op: z.literal("setParents"),
    assignments: z
      .array(
        z
          .object({
            objectId: sketchObjectIdSchema,
            parentId: sketchObjectIdSchema.nullable()
          })
          .strict()
      )
      .min(1)
      .max(SKETCH_MAX_OBJECTS)
  })
  .strict();

export const sketchCallerOperationSchema = z.union([
  sketchCreateOperationSchema,
  sketchUpdateOperationSchema,
  sketchTransformOperationSchema,
  sketchDeleteOperationSchema,
  sketchClearOperationSchema,
  sketchGroupOperationSchema,
  sketchUngroupOperationSchema
]);

export const sketchOperationSchema = z.union([
  sketchCallerOperationSchema,
  sketchRestoreOperationSchema,
  sketchRemoveOperationSchema,
  sketchSetParentsOperationSchema
]);

// --- actor, requests, receipts, state ------------------------------------------

// Authorship is server authority: B03 derives it from the authenticated
// caller or the active runner binding and passes it down here. Nothing in an
// operation payload can influence it.
export const sketchActorSchema = z
  .object({
    kind: z.enum(["human", "agent"]),
    name: z.string().trim().min(1).max(64).optional(),
    runnerId: z.string().trim().min(1).max(64).optional()
  })
  .strict()
  .superRefine((actor, context) => {
    if (actor.kind !== "agent" && actor.runnerId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runnerId is only valid on an agent actor",
        path: ["runnerId"]
      });
    }
  });

export const sketchCommitRequestSchema = z
  .object({
    requestId: sketchRequestIdSchema,
    baseRevision: z.number().int().min(0),
    actor: sketchActorSchema,
    turnId: sketchTurnIdSchema.optional(),
    label: z.string().trim().min(1).max(120).optional(),
    operations: z.array(sketchCallerOperationSchema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS)
  })
  .strict();

export const sketchUndoRedoRequestSchema = z
  .object({
    requestId: sketchRequestIdSchema,
    baseRevision: z.number().int().min(0),
    actor: sketchActorSchema,
    turnId: sketchTurnIdSchema.optional(),
    label: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const sketchReceiptSchema = z
  .object({
    requestId: sketchRequestIdSchema,
    transactionId: z.string().regex(sketchTransactionIdPattern),
    revision: z.number().int().min(1),
    kind: z.enum(["commit", "undo", "redo"]),
    actor: sketchActorSchema,
    turnId: sketchTurnIdSchema.optional(),
    label: z.string().trim().min(1).max(120),
    requestFingerprint: z.string().length(64)
  })
  .strict();

export const sketchHistoryEntrySchema = z
  .object({
    transactionId: z.string().regex(sketchTransactionIdPattern),
    revision: z.number().int().min(1),
    actor: sketchActorSchema,
    turnId: sketchTurnIdSchema.optional(),
    label: z.string().trim().min(1).max(120),
    forwardOps: z.array(sketchOperationSchema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS),
    inverseOps: z.array(sketchOperationSchema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS)
  })
  .strict();

export const sketchStateSchema = z
  .object({
    schemaVersion: z.literal(SKETCH_SCHEMA_VERSION),
    sketchId: sketchIdSchema,
    document: sketchDocumentSchema,
    history: z
      .object({
        undo: z.array(sketchHistoryEntrySchema),
        redo: z.array(sketchHistoryEntrySchema)
      })
      .strict(),
    receipts: z.array(sketchReceiptSchema),
    // Request ids whose receipts were evicted. Defaults so a state written
    // before expiry tracking existed parses unchanged.
    expiredRequestIds: z.array(sketchRequestIdSchema).max(SKETCH_MAX_EXPIRED_REQUEST_IDS).default([])
  })
  .strict();

// --- types ---------------------------------------------------------------------

export type SketchTransform = z.infer<typeof sketchTransformSchema>;
export type SketchStrokeObject = z.infer<typeof sketchStrokeObjectSchema>;
export type SketchBrush = z.infer<typeof sketchBrushSchema>;
export type SketchLineStyle = z.infer<typeof sketchLineStyleSchema>;
export type SketchBoxObject = z.infer<typeof sketchBoxObjectSchema>;
export type SketchTextObject = z.infer<typeof sketchTextObjectSchema>;
export type SketchPlanarShapeObject = z.infer<typeof sketchPlanarShapeObjectSchema>;
export type SketchTextBoxObject = z.infer<typeof sketchTextBoxObjectSchema>;
export type SketchPlanarShapeType = z.infer<typeof sketchPlanarShapeTypeSchema>;
export type SketchShapeAppearance = z.infer<typeof sketchShapeAppearanceSchema>;
export type SketchGroupObject = z.infer<typeof sketchGroupObjectSchema>;
export type SketchUnknownObject = z.infer<typeof sketchUnknownObjectSchema>;
export type SketchObject = z.infer<typeof sketchObjectSchema>;

// The unknown-kind member's `kind` is an open string, which defeats literal
// narrowing on the raw union. This guard restores it: after `isKnownSketchObject`,
// kind-based discrimination works as usual.
export type KnownSketchObject = Extract<SketchObject, { kind: SketchKnownObjectKind }>;

export function isKnownSketchObject(object: SketchObject): object is KnownSketchObject {
  return (SKETCH_KNOWN_OBJECT_KINDS as readonly string[]).includes(object.kind);
}
export type SketchDocument = z.infer<typeof sketchDocumentSchema>;
export type SketchCallerOperation = z.infer<typeof sketchCallerOperationSchema>;
export type SketchOperation = z.infer<typeof sketchOperationSchema>;
export type SketchActor = z.infer<typeof sketchActorSchema>;
export type SketchCommitRequest = z.infer<typeof sketchCommitRequestSchema>;
export type SketchUndoRedoRequest = z.infer<typeof sketchUndoRedoRequestSchema>;
export type SketchReceipt = z.infer<typeof sketchReceiptSchema>;
export type SketchHistoryEntry = z.infer<typeof sketchHistoryEntrySchema>;
export type SketchState = z.infer<typeof sketchStateSchema>;
