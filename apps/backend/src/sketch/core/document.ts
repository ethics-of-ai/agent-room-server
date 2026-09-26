import { z } from "zod";
import {
  SKETCH_DEFAULT_EXTRUSION_DEPTH,
  SKETCH_DEFAULT_TEXT_FONT_SIZE,
  SKETCH_KNOWN_OBJECT_KINDS,
  SKETCH_LEGACY_SCHEMA_VERSION,
  SKETCH_MAX_DOCUMENT_BYTES,
  SKETCH_MAX_STATE_BYTES,
  SKETCH_SCHEMA_VERSION,
  SKETCH_V2_SCHEMA_VERSION
} from "./limits";
import {
  sketchDocumentSchema,
  sketchStateSchema,
  type KnownSketchObject,
  type SketchDocument,
  type SketchHistoryEntry,
  type SketchReceipt,
  type SketchState
} from "./schemas";
import type { SketchCoreError } from "./errors";
import type { SketchTextSpan } from "./textBoxSchemas";
import {
  SKETCH_LEGACY_KNOWN_OBJECT_KINDS,
  sketchDocumentV1Schema,
  sketchStateV1Schema
} from "./schemasV1";
import {
  sketchDocumentV2Schema,
  sketchObjectV2Schema,
  sketchStateV2Schema
} from "./schemasV2";
import { checkSketchObjects } from "./invariants";
import { defaultTextParagraphs } from "./textBoxFormat";

// Canonical serialization and guarded parsing for sketch documents and whole
// evaluator state. Every durable or wire form of a sketch goes through here:
// raw `sketchDocumentSchema.parse` at call sites would skip the cross-object
// invariants, the unknown-version rule, and the size cap.
//
// Canonical form pins field order to the zod schema shape order (the same
// discipline as the diagram engine's canonical serializer): a document that
// arrived with fields shuffled must not churn storage when re-serialized,
// and serialize(parse(x)) must reproduce x byte for byte. Unknown-kind
// objects keep their passthrough fields verbatim after `id` and `kind`.

const MAX_REPORTED_ISSUES = 20;

export type SketchParseResult<T> = { ok: true; value: T } | { ok: false; error: SketchCoreError };

export function serializeSketchDocument(document: SketchDocument): string {
  return JSON.stringify(canonicalDocument(document));
}

export function serializeSketchState(state: SketchState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    sketchId: state.sketchId,
    document: canonicalDocument(state.document),
    history: {
      undo: state.history.undo.map(canonicalHistoryEntry),
      redo: state.history.redo.map(canonicalHistoryEntry)
    },
    receipts: state.receipts.map(canonicalReceipt),
    expiredRequestIds: [...state.expiredRequestIds]
  });
}

export function measureSketchDocumentBytes(document: SketchDocument): number {
  return Buffer.byteLength(serializeSketchDocument(document));
}

function canonicalDocument(document: SketchDocument): SketchDocument {
  return {
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    sketchId: document.sketchId,
    revision: document.revision,
    objects: document.objects.map(canonicalObject)
  };
}

function canonicalObject(object: SketchDocument["objects"][number]): SketchDocument["objects"][number] {
  const known = object as KnownSketchObject;
  if (known.kind === "stroke" || known.kind === "box" || known.kind === "text" || known.kind === "planarShape" || known.kind === "textBox" || known.kind === "group") {
    const parentId = (object as { parentId?: string }).parentId;
    const color = (object as { color?: string }).color;
    const transform = (object as { transform?: CanonicalTransform }).transform;
    return {
      id: object.id,
      kind: object.kind,
      ...(parentId === undefined ? {} : { parentId }),
      ...(known.kind === "stroke" ? {
        points: known.points.map((point) => [...point] as [number, number, number]),
        width: known.width,
        brush: known.brush,
        lineStyle: known.lineStyle
      } : {}),
      ...(known.kind === "box" ? { size: [...known.size] as [number, number, number] } : {}),
      ...(known.kind === "text" ? { text: known.text } : {}),
      ...(known.kind === "planarShape" ? {
        shapeType: known.shapeType,
        size: [...known.size] as [number, number],
        appearance: known.appearance,
        fillColor: known.fillColor,
        outlineColor: known.outlineColor,
        outlineWidth: known.outlineWidth
      } : {}),
      ...(known.kind === "textBox" ? {
        text: known.text,
        ...(color === undefined ? {} : { color }),
        font: { family: known.font.family, size: known.font.size },
        paragraphs: known.paragraphs.map((paragraph) => ({
          style: paragraph.style,
          alignment: paragraph.alignment,
          list: paragraph.list
        })),
        spans: known.spans.map(canonicalSpan),
        rendering: known.rendering,
        extrusionDepth: known.extrusionDepth,
        size: [...known.size] as [number, number],
        appearance: known.appearance,
        fillColor: known.fillColor,
        outlineColor: known.outlineColor,
        outlineWidth: known.outlineWidth
      } : {}),
      ...(known.kind === "textBox" || color === undefined ? {} : { color }),
      ...(transform === undefined ? {} : { transform: canonicalTransform(transform) })
    };
  }
  // Unknown kind: `id` and `kind` first, remaining fields in their existing
  // order, values untouched.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== "id" && key !== "kind") {
      rest[key] = value;
    }
  }
  return { id: object.id, kind: object.kind, ...rest };
}

function canonicalSpan(span: SketchTextSpan): SketchTextSpan {
  return {
    start: span.start,
    length: span.length,
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.italic === true ? { italic: true } : {}),
    ...(span.underline === true ? { underline: true } : {}),
    ...(span.strikethrough === true ? { strikethrough: true } : {})
  };
}

type CanonicalTransform = {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

function canonicalTransform(transform: CanonicalTransform): CanonicalTransform {
  return {
    translation: [...transform.translation] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number]
  };
}

function canonicalHistoryEntry(entry: SketchHistoryEntry): SketchHistoryEntry {
  return {
    transactionId: entry.transactionId,
    revision: entry.revision,
    actor: canonicalActor(entry.actor),
    ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
    label: entry.label,
    forwardOps: entry.forwardOps,
    inverseOps: entry.inverseOps
  };
}

function canonicalReceipt(receipt: SketchReceipt): SketchReceipt {
  return {
    requestId: receipt.requestId,
    transactionId: receipt.transactionId,
    revision: receipt.revision,
    kind: receipt.kind,
    actor: canonicalActor(receipt.actor),
    ...(receipt.turnId === undefined ? {} : { turnId: receipt.turnId }),
    label: receipt.label,
    requestFingerprint: receipt.requestFingerprint
  };
}

function canonicalActor(actor: SketchReceipt["actor"]): SketchReceipt["actor"] {
  return {
    kind: actor.kind,
    ...(actor.name === undefined ? {} : { name: actor.name }),
    ...(actor.runnerId === undefined ? {} : { runnerId: actor.runnerId })
  };
}

export function parseSketchDocument(serialized: string): SketchParseResult<SketchDocument> {
  let value: unknown;
  if (!tryParseJson(serialized, (parsed) => (value = parsed))) {
    return { ok: false, error: { code: "invalid_document", message: "Sketch document is not valid JSON" } };
  }
  const versionIssue = checkSupportedVersion(value);
  if (versionIssue !== null) {
    return { ok: false, error: versionIssue };
  }
  const sizeIssue = checkDocumentBytes(serialized);
  if (sizeIssue !== null) {
    return { ok: false, error: sizeIssue };
  }
  const upgraded = upgradeStored(value, DOCUMENT_FORM);
  if (!upgraded.ok) {
    return upgraded;
  }
  const parsed = sketchDocumentSchema.safeParse(upgraded.value);
  if (!parsed.success) {
    return { ok: false, error: invalidDocumentError(parsed.error) };
  }
  const invariant = checkSketchObjects(parsed.data.objects);
  if (invariant !== null) {
    return {
      ok: false,
      error: { code: "invalid_document", message: invariant.message }
    };
  }
  return { ok: true, value: parsed.data };
}

export function parseSketchState(serialized: string): SketchParseResult<SketchState> {
  let value: unknown;
  if (!tryParseJson(serialized, (parsed) => (value = parsed))) {
    return { ok: false, error: { code: "invalid_document", message: "Sketch state is not valid JSON" } };
  }
  const versionIssue = checkSupportedVersion(value);
  if (versionIssue !== null) {
    return { ok: false, error: versionIssue };
  }
  // The state-level ceiling, not the document cap: a state legitimately wraps
  // retained history alongside the document it shadows.
  const bytes = Buffer.byteLength(serialized);
  if (bytes > SKETCH_MAX_STATE_BYTES) {
    return {
      ok: false,
      error: {
        code: "invalid_document",
        message: `Sketch state serializes to ${bytes} bytes; the maximum is ${SKETCH_MAX_STATE_BYTES}`
      }
    };
  }
  const upgraded = upgradeStored(value, STATE_FORM);
  if (!upgraded.ok) {
    return upgraded;
  }
  const parsed = sketchStateSchema.safeParse(upgraded.value);
  if (!parsed.success) {
    return { ok: false, error: invalidDocumentError(parsed.error) };
  }
  const state = parsed.data;
  if (state.document.sketchId !== state.sketchId) {
    return {
      ok: false,
      error: {
        code: "invalid_document",
        message: `State sketch id "${state.sketchId}" does not match document sketch id "${state.document.sketchId}"`
      }
    };
  }
  const invariant = checkSketchObjects(state.document.objects);
  if (invariant !== null) {
    return { ok: false, error: { code: "invalid_document", message: invariant.message } };
  }
  return { ok: true, value: state };
}

// Older versions upgrade one step at a time, each validated strictly as its
// own version first: version 1 to version 2, then version 2 to the current
// version. Upgrades happen in memory; only a later successful edit writes
// the current version.
function schemaVersionOf(value: unknown): unknown {
  return isRecord(value) ? value.schemaVersion : undefined;
}

// One version step. Documents and states upgrade through the same step: a
// state is its document plus history entries whose operations need the same
// treatment, so only the schemas that validate the input differ.
interface UpgradeStep {
  toVersion: number;
  object: (object: unknown) => unknown;
  operation: (operation: unknown) => unknown;
}

const V1_TO_V2: UpgradeStep = {
  toVersion: SKETCH_V2_SCHEMA_VERSION,
  object: upgradeV1Object,
  operation: upgradeV1Operation
};

const V2_TO_CURRENT: UpgradeStep = {
  toVersion: SKETCH_SCHEMA_VERSION,
  object: upgradeV2Object,
  operation: upgradeV2Operation
};

interface StoredDocument {
  objects: readonly unknown[];
}

interface StoredHistoryEntry {
  forwardOps: readonly unknown[];
  inverseOps: readonly unknown[];
}

interface StoredState {
  document: StoredDocument;
  history: { undo: readonly StoredHistoryEntry[]; redo: readonly StoredHistoryEntry[] };
}

type VersionSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: z.ZodError };
};

interface UpgradableForm<T> {
  v1: VersionSchema<T>;
  v2: VersionSchema<T>;
  apply: (value: T, step: UpgradeStep) => unknown;
}

const DOCUMENT_FORM: UpgradableForm<StoredDocument> = {
  v1: sketchDocumentV1Schema,
  v2: sketchDocumentV2Schema,
  apply: upgradeDocumentStep
};

const STATE_FORM: UpgradableForm<StoredState> = {
  v1: sketchStateV1Schema,
  v2: sketchStateV2Schema,
  apply: upgradeStateStep
};

function upgradeStored<T>(value: unknown, form: UpgradableForm<T>): SketchParseResult<unknown> {
  let current = value;
  let fromV1 = false;
  if (schemaVersionOf(current) === SKETCH_LEGACY_SCHEMA_VERSION) {
    const legacy = form.v1.safeParse(current);
    if (!legacy.success) {
      return { ok: false, error: invalidDocumentError(legacy.error) };
    }
    current = form.apply(legacy.data, V1_TO_V2);
    fromV1 = true;
  }
  if (schemaVersionOf(current) === SKETCH_V2_SCHEMA_VERSION) {
    const v2 = form.v2.safeParse(current);
    if (!v2.success) {
      return { ok: false, error: (fromV1 ? reclaimedKindError(current) : null) ?? invalidDocumentError(v2.error) };
    }
    current = form.apply(v2.data, V2_TO_CURRENT);
  }
  return { ok: true, value: current };
}

function upgradeStateStep(state: StoredState, step: UpgradeStep): unknown {
  const upgradeEntry = (entry: StoredHistoryEntry) => ({
    ...entry,
    forwardOps: entry.forwardOps.map(step.operation),
    inverseOps: entry.inverseOps.map(step.operation)
  });
  return {
    ...state,
    schemaVersion: step.toVersion,
    document: upgradeDocumentStep(state.document, step),
    history: {
      undo: state.history.undo.map(upgradeEntry),
      redo: state.history.redo.map(upgradeEntry)
    }
  };
}

function upgradeDocumentStep(document: StoredDocument, step: UpgradeStep): unknown {
  return {
    ...document,
    schemaVersion: step.toVersion,
    objects: document.objects.map(step.object)
  };
}

function upgradeV1Object(object: unknown): unknown {
  if (!isRecord(object) || object.kind !== "stroke") return object;
  return { ...object, brush: "finePen", lineStyle: "solid" };
}

function upgradeV1Operation(operation: unknown): unknown {
  if (!isRecord(operation)) return operation;
  if (operation.op === "create" && operation.kind === "stroke") {
    return { ...operation, brush: "finePen", lineStyle: "solid" };
  }
  if (operation.op === "restore" && Array.isArray(operation.objects)) {
    return { ...operation, objects: operation.objects.map(upgradeV1Object) };
  }
  return operation;
}

// A version-2 text box reads as plain text: the system family at the size
// the flat panel already used, one Body paragraph per line, no spans, flat.
function upgradeV2Object(object: unknown): unknown {
  if (!isRecord(object) || object.kind !== "textBox" || typeof object.text !== "string") return object;
  return {
    ...object,
    font: { family: "system", size: SKETCH_DEFAULT_TEXT_FONT_SIZE },
    paragraphs: defaultTextParagraphs(object.text),
    spans: [],
    rendering: "flat",
    extrusionDepth: SKETCH_DEFAULT_EXTRUSION_DEPTH
  };
}

// Creates fill their own defaults when applied. A text update must now carry
// its formatting, so a stored version-2 one gains the plain defaults for the
// text it sets, which is what that text had.
function upgradeV2Operation(operation: unknown): unknown {
  if (!isRecord(operation)) return operation;
  if (operation.op === "update" && operation.kind === "textBox" && typeof operation.text === "string") {
    return { ...operation, paragraphs: defaultTextParagraphs(operation.text), spans: [] };
  }
  if (operation.op === "restore" && Array.isArray(operation.objects)) {
    return { ...operation, objects: operation.objects.map(upgradeV2Object) };
  }
  return operation;
}

// Version 1 kept any kind it did not define as opaque data, and version 2
// defines `planarShape` and `textBox`. A version-1 object that already used
// one of those names must now match the version-2 definition. When it does
// not, the file cannot be upgraded without changing that object, so the read
// names the object and fails, leaving the stored file untouched.
function reclaimedKindError(upgraded: unknown): SketchCoreError | null {
  const object = reclaimedKindObjects(upgraded)[0];
  if (object === undefined) return null;
  return {
    code: "invalid_document",
    message: `Version 1 object "${String(object.id)}" uses kind "${String(object.kind)}", which version 2 defines, ` +
      "and it does not match that definition; the file was left unchanged"
  };
}

function reclaimedKindObjects(upgraded: unknown): Record<string, unknown>[] {
  if (!isRecord(upgraded)) return [];
  const document = isRecord(upgraded.document) ? upgraded.document : upgraded;
  const candidates: unknown[] = Array.isArray(document.objects) ? [...document.objects] : [];
  if (isRecord(upgraded.history)) {
    for (const entries of [upgraded.history.undo, upgraded.history.redo]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        for (const operation of [entry.forwardOps, entry.inverseOps].flat()) {
          if (isRecord(operation) && operation.op === "restore" && Array.isArray(operation.objects)) {
            candidates.push(...operation.objects);
          }
        }
      }
    }
  }
  return candidates.filter((object): object is Record<string, unknown> =>
    isRecord(object) &&
    typeof object.kind === "string" &&
    (SKETCH_KNOWN_OBJECT_KINDS as readonly string[]).includes(object.kind) &&
    !SKETCH_LEGACY_KNOWN_OBJECT_KINDS.includes(object.kind) &&
    !sketchObjectV2Schema.safeParse(object).success);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A newer document version fails explicitly with the versions named — the
// caller decides between read-only presentation and a hard error. It never
// decays into an empty sketch or a generic validation failure.
function checkSupportedVersion(value: unknown): SketchCoreError | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || version <= SKETCH_SCHEMA_VERSION) {
    return null;
  }
  return {
    code: "newer_document_version",
    message: `Sketch document version ${version} is newer than supported version ${SKETCH_SCHEMA_VERSION}`,
    supportedVersion: SKETCH_SCHEMA_VERSION,
    foundVersion: version
  };
}

// The serialized size cap applies to stored forms as well as evaluator
// output: a document this large is foreign or corrupted, not a sketch a
// bounded sequence of operations could have produced.
function checkDocumentBytes(serialized: string): SketchCoreError | null {
  const bytes = Buffer.byteLength(serialized);
  if (bytes > SKETCH_MAX_DOCUMENT_BYTES) {
    return {
      code: "invalid_document",
      message: `Sketch document serializes to ${bytes} bytes; the maximum is ${SKETCH_MAX_DOCUMENT_BYTES}`
    };
  }
  return null;
}

function tryParseJson(serialized: string, accept: (parsed: unknown) => void): boolean {
  try {
    accept(JSON.parse(serialized));
    return true;
  } catch {
    return false;
  }
}

function invalidDocumentError(error: z.ZodError): SketchCoreError {
  const issues = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return {
    code: "invalid_document",
    message: `Sketch document failed validation: ${issues.join("; ")}${
      error.issues.length > MAX_REPORTED_ISSUES
        ? ` (and ${error.issues.length - MAX_REPORTED_ISSUES} more)`
        : ""
    }`
  };
}
