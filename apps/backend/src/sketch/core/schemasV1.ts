import { z } from "zod";
import {
  SKETCH_LEGACY_SCHEMA_VERSION,
  SKETCH_MAX_BATCH_OPERATIONS,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_OBJECTS
} from "./limits";
import {
  requireUpdateField,
  sketchActorSchema,
  sketchBoxCreateSchema,
  sketchBoxObjectSchema,
  sketchBoxUpdateSchema,
  sketchDeleteOperationSchema,
  sketchGroupObjectSchema,
  sketchGroupOperationSchema,
  sketchIdSchema,
  sketchObjectIdSchema,
  sketchReceiptSchema,
  sketchRemoveOperationSchema,
  sketchRequestIdSchema,
  sketchSetParentsOperationSchema,
  sketchStrokeCreateSchema,
  sketchStrokeObjectSchema,
  sketchStrokeUpdateFields,
  sketchTextCreateSchema,
  sketchTextObjectSchema,
  sketchTextUpdateSchema,
  sketchTransformOperationSchema,
  sketchTurnIdSchema,
  sketchUngroupOperationSchema
} from "./schemas";

// V1 accepts only the original known kinds. Future kinds, including shapes,
// remain passthrough data so opening a legacy document never discards them.
export const SKETCH_LEGACY_KNOWN_OBJECT_KINDS: readonly string[] = ["stroke", "box", "text", "group"];
const sketchUnknownObjectV1Schema = z.object({
  id: sketchObjectIdSchema,
  kind: z.string().min(1).max(64)
}).passthrough().superRefine((object, context) => {
  if (SKETCH_LEGACY_KNOWN_OBJECT_KINDS.includes(object.kind)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Kind "${object.kind}" is a legacy known kind and must match its strict schema`,
      path: ["kind"]
    });
  }
});

const sketchStrokeObjectV1Schema = sketchStrokeObjectSchema.omit({ brush: true, lineStyle: true }).strict();
const sketchObjectV1Schema = z.union([
  sketchStrokeObjectV1Schema,
  sketchBoxObjectSchema,
  sketchTextObjectSchema,
  sketchGroupObjectSchema,
  sketchUnknownObjectV1Schema
]);

export const sketchDocumentV1Schema = z.object({
  schemaVersion: z.literal(SKETCH_LEGACY_SCHEMA_VERSION),
  kind: z.literal("sketch"),
  sketchId: sketchIdSchema,
  revision: z.number().int().min(0),
  objects: z.array(sketchObjectV1Schema).max(SKETCH_MAX_OBJECTS)
}).strict();

// Version 1 had no brush or line style and none of the planar kinds; its
// operation unions reuse the version-2 members with those parts removed.
const sketchCreateOperationV1Schema = z.union([
  sketchStrokeCreateSchema.omit({ brush: true, lineStyle: true }),
  sketchBoxCreateSchema,
  sketchTextCreateSchema
]);
const sketchUpdateOperationV1Schema = z.union([
  requireUpdateField(z.object(sketchStrokeUpdateFields).strict()),
  sketchBoxUpdateSchema,
  sketchTextUpdateSchema
]);
const sketchRestoreOperationV1Schema = z.object({
  op: z.literal("restore"),
  objects: z.array(sketchObjectV1Schema).min(1).max(SKETCH_MAX_OBJECTS)
}).strict();
const sketchOperationV1Schema = z.union([
  sketchCreateOperationV1Schema,
  sketchUpdateOperationV1Schema,
  sketchTransformOperationSchema,
  sketchDeleteOperationSchema,
  sketchGroupOperationSchema,
  sketchUngroupOperationSchema,
  sketchRestoreOperationV1Schema,
  sketchRemoveOperationSchema,
  sketchSetParentsOperationSchema
]);
const sketchHistoryEntryV1Schema = z.object({
  transactionId: z.string().regex(/^tx-[0-9]+$/),
  revision: z.number().int().min(1),
  actor: sketchActorSchema,
  turnId: sketchTurnIdSchema.optional(),
  label: z.string().trim().min(1).max(120),
  forwardOps: z.array(sketchOperationV1Schema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS),
  inverseOps: z.array(sketchOperationV1Schema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS)
}).strict();

export const sketchStateV1Schema = z.object({
  schemaVersion: z.literal(SKETCH_LEGACY_SCHEMA_VERSION),
  sketchId: sketchIdSchema,
  document: sketchDocumentV1Schema,
  history: z.object({
    undo: z.array(sketchHistoryEntryV1Schema),
    redo: z.array(sketchHistoryEntryV1Schema)
  }).strict(),
  receipts: z.array(sketchReceiptSchema),
  expiredRequestIds: z.array(sketchRequestIdSchema).max(SKETCH_MAX_EXPIRED_REQUEST_IDS).default([])
}).strict();

export type SketchDocumentV1 = z.infer<typeof sketchDocumentV1Schema>;
export type SketchStateV1 = z.infer<typeof sketchStateV1Schema>;
