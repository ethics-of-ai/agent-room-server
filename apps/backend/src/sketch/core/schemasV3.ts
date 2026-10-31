import { z } from "zod";
import {
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_OBJECTS,
  SKETCH_V3_SCHEMA_VERSION
} from "./limits";
import {
  sketchBoxObjectSchema,
  sketchClearOperationSchema,
  sketchDeleteOperationSchema,
  sketchDrawingCreateOperationSchema,
  sketchDrawingUpdateOperationSchema,
  sketchGroupObjectSchema,
  sketchGroupOperationSchema,
  sketchHistoryEntrySchemaOf,
  sketchIdSchema,
  sketchPlanarShapeObjectSchema,
  sketchReceiptSchema,
  sketchRemoveOperationSchema,
  sketchRequestIdSchema,
  sketchRevisionLogSchema,
  sketchSetParentsOperationSchema,
  sketchStrokeObjectSchema,
  sketchTextBoxObjectSchema,
  sketchTextObjectSchema,
  sketchTransformOperationSchema,
  sketchUngroupOperationSchema
} from "./schemas";
import { unknownSketchObjectSchema } from "./fieldSchemas";

// Version 3 is version 4 without tables and pieces. It kept any kind it did
// not define, `piece` included, as opaque data, so its unknown-kind rule is
// its own. Version 2 shares that rule: it defines the same kinds.

export const SKETCH_V3_KNOWN_OBJECT_KINDS: readonly string[] = ["stroke", "box", "text", "planarShape", "textBox", "group"];

export const sketchUnknownObjectV3Schema = unknownSketchObjectSchema(SKETCH_V3_KNOWN_OBJECT_KINDS);

export const sketchObjectV3Schema = z.union([
  sketchStrokeObjectSchema,
  sketchBoxObjectSchema,
  sketchTextObjectSchema,
  sketchPlanarShapeObjectSchema,
  sketchTextBoxObjectSchema,
  sketchGroupObjectSchema,
  sketchUnknownObjectV3Schema
]);

export const sketchDocumentV3Schema = z.object({
  schemaVersion: z.literal(SKETCH_V3_SCHEMA_VERSION),
  kind: z.literal("sketch"),
  sketchId: sketchIdSchema,
  revision: z.number().int().min(0),
  objects: z.array(sketchObjectV3Schema).max(SKETCH_MAX_OBJECTS)
}).strict();

const sketchOperationV3Schema = z.union([
  sketchDrawingCreateOperationSchema,
  sketchDrawingUpdateOperationSchema,
  sketchTransformOperationSchema,
  sketchDeleteOperationSchema,
  sketchClearOperationSchema,
  sketchGroupOperationSchema,
  sketchUngroupOperationSchema,
  z.object({
    op: z.literal("restore"),
    objects: z.array(sketchObjectV3Schema).min(1).max(SKETCH_MAX_OBJECTS)
  }).strict(),
  sketchRemoveOperationSchema,
  sketchSetParentsOperationSchema
]);

const sketchHistoryEntryV3Schema = sketchHistoryEntrySchemaOf(sketchOperationV3Schema);

export const sketchStateV3Schema = z.object({
  schemaVersion: z.literal(SKETCH_V3_SCHEMA_VERSION),
  sketchId: sketchIdSchema,
  document: sketchDocumentV3Schema,
  history: z.object({
    undo: z.array(sketchHistoryEntryV3Schema),
    redo: z.array(sketchHistoryEntryV3Schema)
  }).strict(),
  receipts: z.array(sketchReceiptSchema),
  expiredRequestIds: z.array(sketchRequestIdSchema).max(SKETCH_MAX_EXPIRED_REQUEST_IDS).default([]),
  revisionLog: sketchRevisionLogSchema.optional()
}).strict();

export type SketchDocumentV3 = z.infer<typeof sketchDocumentV3Schema>;
export type SketchStateV3 = z.infer<typeof sketchStateV3Schema>;
