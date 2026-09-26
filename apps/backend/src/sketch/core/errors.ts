import type { SketchLimitName } from "./limits";

// The typed error every sketch core entry point returns. Codes are the
// caller-facing vocabulary; the optional fields carry what a caller needs to
// act on the code without another read.

export const SKETCH_ERROR_CODES = [
  "invalid_request",
  "stale_revision",
  "request_id_conflict",
  "outcome_unknown",
  "unknown_object",
  "duplicate_object_id",
  "invalid_operation",
  "group_cycle",
  "unsupported_object_kind",
  "limit_exceeded",
  "out_of_bounds",
  "nothing_to_undo",
  "nothing_to_redo",
  "invalid_document",
  "newer_document_version"
] as const;
export type SketchErrorCode = (typeof SKETCH_ERROR_CODES)[number];

export interface SketchCoreError {
  code: SketchErrorCode;
  message: string;
  // Set when a single operation in a batch is at fault.
  opIndex?: number;
  // Set on stale_revision so a caller can refresh without another read.
  currentRevision?: number;
  // Set on limit_exceeded; names the cap from SKETCH_LIMIT_NAMES.
  limit?: SketchLimitName;
  // Set on newer_document_version.
  supportedVersion?: number;
  foundVersion?: number;
}
