// Public seam of the sketch editing core. The repository sketch service and
// routes consume only what this module exports; anything else under
// `sketch/core` is implementation.

export {
  SKETCH_KNOWN_OBJECT_KINDS,
  SKETCH_LIMIT_NAMES,
  SKETCH_SCHEMA_VERSION,
  SKETCH_V2_SCHEMA_VERSION,
  SKETCH_LEGACY_SCHEMA_VERSION,
  SKETCH_DEFAULT_BRUSH,
  SKETCH_DEFAULT_LINE_STYLE,
  SKETCH_COORDINATE_LIMIT,
  SKETCH_MAX_BATCH_BYTES,
  SKETCH_MAX_BATCH_OPERATIONS,
  SKETCH_MAX_BOX_DIMENSION,
  SKETCH_MAX_DOCUMENT_BYTES,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_GROUP_DEPTH,
  SKETCH_MAX_OBJECTS,
  SKETCH_MAX_RETAINED_RECEIPTS,
  SKETCH_MAX_STATE_BYTES,
  SKETCH_MAX_STROKE_POINTS,
  SKETCH_MAX_STROKE_WIDTH,
  SKETCH_MAX_PATTERN_SEGMENTS,
  SKETCH_MAX_SHAPE_SEGMENTS,
  SKETCH_ELLIPSE_SEGMENTS,
  SKETCH_MAX_TEXT_CHARACTERS,
  SKETCH_MIN_TEXT_FONT_SIZE,
  SKETCH_MAX_TEXT_FONT_SIZE,
  SKETCH_DEFAULT_TEXT_FONT_SIZE,
  SKETCH_MAX_TEXT_SPANS,
  SKETCH_MIN_EXTRUSION_DEPTH,
  SKETCH_MAX_EXTRUSION_DEPTH,
  SKETCH_DEFAULT_EXTRUSION_DEPTH,
  SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS,
  SKETCH_MAX_TOTAL_EXTRUDED_TEXT_CHARACTERS,
  SKETCH_MAX_TOTAL_POINTS,
  SKETCH_MAX_UNDO_ENTRIES,
  SKETCH_HISTORY_BYTE_BUDGET,
  SKETCH_MIN_DIMENSION,
  SKETCH_DEFAULT_OUTLINE_WIDTH,
  SKETCH_MAX_OUTLINE_WIDTH,
  SKETCH_MIN_SCALE,
  SKETCH_MAX_SCALE,
  SKETCH_MIN_STROKE_POINTS,
  type SketchKnownObjectKind,
  type SketchLimitName
} from "./limits";

export { SKETCH_ERROR_CODES, type SketchCoreError, type SketchErrorCode } from "./errors";

export {
  sketchActorSchema,
  sketchBoxObjectSchema,
  sketchCallerOperationSchema,
  sketchBrushSchema,
  sketchColorSchema,
  sketchCommitRequestSchema,
  sketchCreateOperationSchema,
  sketchDeleteOperationSchema,
  sketchClearOperationSchema,
  sketchDocumentSchema,
  sketchGroupObjectSchema,
  sketchGroupOperationSchema,
  sketchHistoryEntrySchema,
  sketchLineStyleSchema,
  sketchPlanarShapeObjectSchema,
  sketchPlanarShapeTypeSchema,
  sketchShapeAppearanceSchema,
  sketchIdSchema,
  sketchObjectIdSchema,
  sketchReceiptSchema,
  sketchRequestIdSchema,
  sketchStateSchema,
  sketchStrokeObjectSchema,
  sketchTextObjectSchema,
  sketchTextBoxObjectSchema,
  sketchTransformOperationSchema,
  sketchTransformSchema,
  sketchTurnIdSchema,
  sketchUngroupOperationSchema,
  sketchUnknownObjectSchema,
  sketchUndoRedoRequestSchema,
  sketchUpdateOperationSchema,
  type SketchActor,
  type SketchBrush,
  type SketchBoxObject,
  type SketchCallerOperation,
  type SketchDocument,
  type SketchGroupObject,
  type SketchHistoryEntry,
  type SketchLineStyle,
  type SketchPlanarShapeObject,
  type SketchPlanarShapeType,
  type SketchShapeAppearance,
  type SketchObject,
  type SketchOperation,
  type SketchReceipt,
  type SketchState,
  type SketchStrokeObject,
  type SketchTextObject,
  type SketchTextBoxObject,
  type SketchTransform,
  type SketchUnknownObject
} from "./schemas";

export {
  sketchDocumentV1Schema,
  sketchStateV1Schema,
  type SketchDocumentV1,
  type SketchStateV1
} from "./schemasV1";

export {
  sketchTextBoxAppearanceSchema,
  sketchTextFontSchema,
  sketchTextParagraphSchema,
  sketchTextRenderingSchema,
  sketchTextSpanSchema,
  type SketchTextBoxAppearance,
  type SketchTextFont,
  type SketchTextParagraph,
  type SketchTextSpan
} from "./textBoxSchemas";

export {
  sketchDocumentV2Schema,
  sketchStateV2Schema,
  type SketchDocumentV2,
  type SketchStateV2
} from "./schemasV2";

export {
  measureSketchDocumentBytes,
  parseSketchDocument,
  parseSketchState,
  serializeSketchDocument,
  serializeSketchState,
  type SketchParseResult
} from "./document";

export {
  SKETCH_IDENTITY_TRANSFORM,
  boxCorners,
  composeSketchTransform,
  isWithinSketchCube,
  quatMultiply,
  quatNorm,
  resolveSketchTransform,
  rotateVector,
  transformPoint,
  type Quaternion,
  type Vec3
} from "./geometry";

export {
  checkSketchObjects,
  type SketchInvariantIssue
} from "./invariants";

export { applyOperations, type AppliedOps } from "./operations";

export {
  createSketchState,
  evaluateSketchCommit,
  redoSketchTransaction,
  undoSketchTransaction,
  type SketchTransactionResult
} from "./evaluate";

export {
  FIXTURE_SKETCH_ID,
  documentWithUnknownObject,
  helixStrokePoints,
  nonPlanarSketchCreateOperations,
  nonPlanarSketchDocument,
  nonPlanarSketchObjects,
  unknownKindObject
} from "./fixtures";
