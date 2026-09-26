// Centralized bounds for the sketch document core. Every cap the evaluator
// enforces lives here so callers can advertise exact limits and tests can push
// each one to its edge. These are starting values, not measured device limits.
// Change one only from recorded headset measurements, update
// docs/api/API.md#operations-and-limits in the same change, and never override
// a cap per call site.

export const SKETCH_SCHEMA_VERSION = 3;
export const SKETCH_V2_SCHEMA_VERSION = 2;
export const SKETCH_LEGACY_SCHEMA_VERSION = 1;

// Whole-document caps. The object count includes groups and preserved
// unknown-kind objects: they all occupy ids, parent links, and render slots.
export const SKETCH_MAX_OBJECTS = 128;
export const SKETCH_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

// Geometry caps.
export const SKETCH_MAX_STROKE_POINTS = 2048;
export const SKETCH_MIN_STROKE_POINTS = 2;
export const SKETCH_MAX_TOTAL_POINTS = 16384;
// Patterned strokes are expanded into repeated mesh runs. This cap bounds
// generated geometry independently from the number of source points.
export const SKETCH_MAX_PATTERN_SEGMENTS = 8192;
// Planar shapes expand into polygon fill and/or outline geometry. Count both
// passes so repeated ellipses cannot consume unbounded render work.
export const SKETCH_MAX_SHAPE_SEGMENTS = 8192;
export const SKETCH_MAX_TEXT_CHARACTERS = 1000;
// Text boxes. Font size is the Body size in meters; the other paragraph
// styles scale from it on the client. Extruded text costs about three mesh
// instances per glyph, so it has its own lower caps. Raising a cap later keeps
// old files valid; lowering one would make them fail.
export const SKETCH_MIN_TEXT_FONT_SIZE = 0.005;
export const SKETCH_MAX_TEXT_FONT_SIZE = 0.25;
export const SKETCH_DEFAULT_TEXT_FONT_SIZE = 0.0125;
export const SKETCH_MAX_TEXT_SPANS = 256;
export const SKETCH_MIN_EXTRUSION_DEPTH = 0.001;
export const SKETCH_MAX_EXTRUSION_DEPTH = 0.1;
export const SKETCH_DEFAULT_EXTRUSION_DEPTH = 0.02;
export const SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS = 280;
export const SKETCH_MAX_TOTAL_EXTRUDED_TEXT_CHARACTERS = 560;
// Meters. The minimum keeps widths and box dimensions clear of degenerate
// zero-size geometry; the maxima stay inside what a 10 m volume can display.
export const SKETCH_MIN_DIMENSION = 0.001;
export const SKETCH_MAX_STROKE_WIDTH = 0.2;
export const SKETCH_MAX_BOX_DIMENSION = 10;
export const SKETCH_MAX_OUTLINE_WIDTH = 0.1;
export const SKETCH_DEFAULT_OUTLINE_WIDTH = 0.004;
export const SKETCH_ELLIPSE_SEGMENTS = 64;
export const SKETCH_DEFAULT_BRUSH = "finePen" as const;
export const SKETCH_DEFAULT_LINE_STYLE = "solid" as const;

// Coordinates live in a 10-meter cube centered on the sketch origin, faces
// inclusive — reachable geometry may sit exactly on a face (B01 relies on the
// clamp landing there).
export const SKETCH_COORDINATE_LIMIT = 5;

// Transforms.
export const SKETCH_MIN_SCALE = 0.001;
export const SKETCH_MAX_SCALE = 100;
// Stored rotations are normalized quaternions; round-trip serialization may
// drift the norm by float epsilon, so normalization is enforced within this
// tolerance rather than exactly.
export const SKETCH_QUATERNION_NORM_TOLERANCE = 1e-3;

// Structure: a parent chain may pass through at most four nested groups.
export const SKETCH_MAX_GROUP_DEPTH = 4;

// Batches.
export const SKETCH_MAX_BATCH_OPERATIONS = 32;
export const SKETCH_MAX_BATCH_BYTES = 256 * 1024;

// History and idempotency retention. Trimming history never discards current
// geometry — only the ability to undo further back.
export const SKETCH_MAX_UNDO_ENTRIES = 50;
export const SKETCH_HISTORY_BYTE_BUDGET = 8 * 1024 * 1024;
export const SKETCH_MAX_RETAINED_RECEIPTS = 256;
// Request ids evicted from the receipt ring stay remembered this much longer.
// A retry arriving after eviction can neither be replayed (the receipt holding
// its fingerprint is gone) nor safely re-executed (it may already have
// committed), so the evaluator keeps the id itself and answers
// `outcome_unknown` instead of guessing through the stale-revision path.
export const SKETCH_MAX_EXPIRED_REQUEST_IDS = 1024;
// The serialized whole-state cap the parse entry points enforce. A state wraps
// a document plus retained history, receipts, and expired ids, so its ceiling
// is derived from those budgets with slack for JSON structure — applying the
// bare document cap here would reject exactly the histories the evaluator is
// allowed to retain.
export const SKETCH_MAX_STATE_BYTES =
  SKETCH_MAX_DOCUMENT_BYTES + SKETCH_HISTORY_BYTE_BUDGET + 512 * 1024;

export const SKETCH_KNOWN_OBJECT_KINDS = ["stroke", "box", "text", "planarShape", "textBox", "group"] as const;
export type SketchKnownObjectKind = (typeof SKETCH_KNOWN_OBJECT_KINDS)[number];

// Machine-readable limit names carried by `limit_exceeded` errors so callers
// can advertise which cap was hit without parsing prose.
export const SKETCH_LIMIT_NAMES = [
  "objects",
  "strokePoints",
  "totalPoints",
  "patternSegments",
  "shapeSegments",
  "textCharacters",
  "extrudedTextCharacters",
  "totalExtrudedTextCharacters",
  "strokeWidth",
  "boxDimension",
  "coordinates",
  "scale",
  "groupDepth",
  "batchOperations",
  "batchBytes",
  "documentBytes",
  "historyEntries",
  "historyBytes"
] as const;
export type SketchLimitName = (typeof SKETCH_LIMIT_NAMES)[number];
