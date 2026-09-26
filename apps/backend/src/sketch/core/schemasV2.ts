import { z } from "zod";
import {
  SKETCH_MAX_BATCH_OPERATIONS,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_OBJECTS,
  SKETCH_V2_SCHEMA_VERSION
} from "./limits";
import {
  requireUpdateField,
  sketchActorSchema,
  sketchBoxCreateSchema,
  sketchBoxObjectSchema,
  sketchBoxUpdateSchema,
  sketchClearOperationSchema,
  sketchDeleteOperationSchema,
  sketchGroupObjectSchema,
  sketchGroupOperationSchema,
  sketchIdSchema,
  sketchPlanarShapeCreateSchema,
  sketchPlanarShapeObjectSchema,
  sketchPlanarShapeUpdateSchema,
  sketchReceiptSchema,
  sketchRemoveOperationSchema,
  sketchRequestIdSchema,
  sketchSetParentsOperationSchema,
  sketchShapeAppearanceSchema,
  sketchStrokeCreateSchema,
  sketchStrokeObjectSchema,
  sketchStrokeStyleUpdateSchema,
  sketchTextBoxCreateSchema,
  sketchTextBoxObjectSchema,
  sketchTextBoxUpdateFields,
  sketchTextCreateSchema,
  sketchTextObjectSchema,
  sketchTextUpdateSchema,
  sketchTransactionIdPattern,
  sketchTransformOperationSchema,
  sketchTurnIdSchema,
  sketchUngroupOperationSchema,
  sketchUnknownObjectSchema
} from "./schemas";
import { SKETCH_TEXT_BOX_FORMAT_KEYS } from "./textBoxSchemas";

// Version 2 is version 3 without text box formatting. It knows the same kinds,
// so its unknown-kind rule is the current one. Every member reuses the
// version-3 definition with the formatting fields removed, and a version-2
// file that already carries one of them fails as a version-2 file.

const omitFormat = Object.fromEntries(SKETCH_TEXT_BOX_FORMAT_KEYS.map((key) => [key, true])) as {
  [K in (typeof SKETCH_TEXT_BOX_FORMAT_KEYS)[number]]: true;
};

// Version 2 text boxes always show part of their panel; `none` is version 3.
const textBoxV2Appearance = { appearance: sketchShapeAppearanceSchema } as const;
const sketchTextBoxObjectV2Schema = sketchTextBoxObjectSchema.omit(omitFormat).extend(textBoxV2Appearance).strict();
export const sketchObjectV2Schema = z.union([
  sketchStrokeObjectSchema,
  sketchBoxObjectSchema,
  sketchTextObjectSchema,
  sketchPlanarShapeObjectSchema,
  sketchTextBoxObjectV2Schema,
  sketchGroupObjectSchema,
  sketchUnknownObjectSchema
]);

export const sketchDocumentV2Schema = z.object({
  schemaVersion: z.literal(SKETCH_V2_SCHEMA_VERSION),
  kind: z.literal("sketch"),
  sketchId: sketchIdSchema,
  revision: z.number().int().min(0),
  objects: z.array(sketchObjectV2Schema).max(SKETCH_MAX_OBJECTS)
}).strict();

const sketchOperationV2Schema = z.union([
  sketchStrokeCreateSchema,
  sketchBoxCreateSchema,
  sketchTextCreateSchema,
  sketchTextBoxCreateSchema.omit(omitFormat).extend(textBoxV2Appearance).strict(),
  sketchPlanarShapeCreateSchema,
  sketchStrokeStyleUpdateSchema,
  sketchBoxUpdateSchema,
  sketchTextUpdateSchema,
  sketchPlanarShapeUpdateSchema,
  requireUpdateField(z.object({
    ...sketchTextBoxUpdateFields,
    appearance: sketchShapeAppearanceSchema.optional()
  }).strict()),
  sketchTransformOperationSchema,
  sketchDeleteOperationSchema,
  sketchClearOperationSchema,
  sketchGroupOperationSchema,
  sketchUngroupOperationSchema,
  z.object({
    op: z.literal("restore"),
    objects: z.array(sketchObjectV2Schema).min(1).max(SKETCH_MAX_OBJECTS)
  }).strict(),
  sketchRemoveOperationSchema,
  sketchSetParentsOperationSchema
]);
const sketchHistoryEntryV2Schema = z.object({
  transactionId: z.string().regex(sketchTransactionIdPattern),
  revision: z.number().int().min(1),
  actor: sketchActorSchema,
  turnId: sketchTurnIdSchema.optional(),
  label: z.string().trim().min(1).max(120),
  forwardOps: z.array(sketchOperationV2Schema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS),
  inverseOps: z.array(sketchOperationV2Schema).min(1).max(SKETCH_MAX_BATCH_OPERATIONS)
}).strict();

export const sketchStateV2Schema = z.object({
  schemaVersion: z.literal(SKETCH_V2_SCHEMA_VERSION),
  sketchId: sketchIdSchema,
  document: sketchDocumentV2Schema,
  history: z.object({
    undo: z.array(sketchHistoryEntryV2Schema),
    redo: z.array(sketchHistoryEntryV2Schema)
  }).strict(),
  receipts: z.array(sketchReceiptSchema),
  expiredRequestIds: z.array(sketchRequestIdSchema).max(SKETCH_MAX_EXPIRED_REQUEST_IDS).default([])
}).strict();

export type SketchDocumentV2 = z.infer<typeof sketchDocumentV2Schema>;
export type SketchStateV2 = z.infer<typeof sketchStateV2Schema>;
