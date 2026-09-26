import {
  SKETCH_IDENTITY_TRANSFORM,
  indexSketchObjects,
  isDescendantOf,
  readParentId,
  resolveSketchTransform,
  subtreeOf
} from "./geometry";
import {
  isKnownSketchObject,
  type KnownSketchObject,
  type SketchDocument,
  type SketchObject,
  type SketchOperation
} from "./schemas";
import type { SketchCoreError } from "./errors";
import { checkSketchObjects, type SketchInvariantKind } from "./invariants";
import { applyPlanarCreate, applyPlanarUpdate } from "./planarObjectOperations";

// Operation application: mutate a working document with one operation,
// return the exact inverse operations that retract it. The evaluator owns
// transactions, revisions, and receipts; this module owns what each of the
// six caller operations (plus the three history-internal ones) does to a
// document and what its compensation is.
//
// Two rules are load-bearing:
//
// - **Every mutation carries its own compensation.** Inverse operations are
//   captured from the pre-mutation state, so undo restores prior geometry
//   exactly instead of approximating it. Internal operations (`restore`,
//   `remove`, `setParents`) exist because user-level operations have
//   cascading semantics (deleting a group removes its subtree) that would
//   make imprecise inverses; they appear only inside stored history.
// - **Structural invariants are checked after every operation.** The caller
//   learns which operation index crossed a bound, and the evaluator discards
//   the working clone — a batch never applies partially.

export type AppliedOps =
  | { ok: true; ops: SketchOperation[] }
  | { ok: false; error: SketchCoreError };

export function applyOperations(
  document: SketchDocument,
  operations: SketchOperation[]
): AppliedOps {
  const inverses: SketchOperation[] = [];
  for (const [opIndex, operation] of operations.entries()) {
    const applied = applyOperation(document, operation);
    if (!applied.ok) {
      return { ok: false, error: withOpIndex(applied.error, opIndex) };
    }
    // Undo the last operation first, but preserve the order within a single
    // operation's inverse (for example, detach members before removing a group).
    inverses.unshift(...applied.inverse);

    const invariant = checkSketchObjects(document.objects);
    if (invariant !== null) {
      return {
        ok: false,
        error: withOpIndex(invariantError(invariant.kind, invariant.message), opIndex)
      };
    }
  }
  return { ok: true, ops: inverses };
}

function withOpIndex(error: SketchCoreError, opIndex: number): SketchCoreError {
  return { ...error, opIndex };
}

function invariantError(kind: SketchInvariantKind, message: string): SketchCoreError {
  switch (kind) {
    case "duplicate_id":
      return { code: "duplicate_object_id", message };
    case "cycle":
      return { code: "group_cycle", message };
    case "group_depth":
      return { code: "limit_exceeded", limit: "groupDepth", message };
    case "object_count":
      return { code: "limit_exceeded", limit: "objects", message };
    case "total_points":
      return { code: "limit_exceeded", limit: "totalPoints", message };
    case "pattern_segments":
      return { code: "limit_exceeded", limit: "patternSegments", message };
    case "shape_segments":
      return { code: "limit_exceeded", limit: "shapeSegments", message };
    case "extruded_text_characters":
      return { code: "limit_exceeded", limit: "extrudedTextCharacters", message };
    case "total_extruded_text_characters":
      return { code: "limit_exceeded", limit: "totalExtrudedTextCharacters", message };
    case "text_format":
      return { code: "invalid_operation", message };
    case "world_bounds":
      return { code: "out_of_bounds", message };
    case "parent_reference":
      return { code: "invalid_operation", message };
  }
}

type OperationOutcome =
  | { ok: false; error: SketchCoreError }
  | { ok: true; inverse: SketchOperation[] };

function applyOperation(document: SketchDocument, operation: SketchOperation): OperationOutcome {
  switch (operation.op) {
    case "create":
      return applyCreate(document, operation);
    case "update":
      return applyUpdate(document, operation);
    case "transform":
      return applyTransform(document, operation);
    case "delete":
      return applyDelete(document, operation);
    case "clear":
      return applyClear(document);
    case "group":
      return applyGroup(document, operation);
    case "ungroup":
      return applyUngroup(document, operation);
    case "restore":
      return applyRestore(document, operation);
    case "remove":
      return applyRemove(document, operation);
    case "setParents":
      return applySetParents(document, operation);
  }
}

function findObject(document: SketchDocument, objectId: string) {
  return document.objects.find((object) => object.id === objectId);
}

function unknownObjectError(objectId: string): SketchCoreError {
  return { code: "unknown_object", message: `Unknown object id "${objectId}"` };
}

function duplicateIdError(objectId: string): SketchCoreError {
  return { code: "duplicate_object_id", message: `Object id "${objectId}" already exists` };
}

// Parent writes go through one helper: known kinds type the field, unknown
// kinds carry it through passthrough, and both paths must behave identically.
function assignParentId(object: SketchObject, parentId: string | null): void {
  const record = object as { parentId?: string };
  if (parentId === null) {
    delete record.parentId;
  } else {
    record.parentId = parentId;
  }
}

// The unknown-kind rule: operations that target an unknown-kind object
// directly are refused (the caller cannot know its semantics), while group
// membership stays structural — a group containing unknown members can still
// be created, moved, and deleted without editing them.
function requireKnownKind(
  document: SketchDocument,
  objectId: string
): { error: SketchCoreError } | { object: KnownSketchObject } {
  const object = findObject(document, objectId);
  if (object === undefined) {
    return { error: unknownObjectError(objectId) };
  }
  if (!isKnownSketchObject(object)) {
    return {
      error: {
        code: "unsupported_object_kind",
        message: `Object "${objectId}" has unsupported kind "${object.kind}" and cannot be edited`
      }
    };
  }
  return { object };
}

function freshIdentityTransform() {
  return structuredClone(SKETCH_IDENTITY_TRANSFORM);
}

function applyCreate(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "create" }>
): OperationOutcome {
  if (findObject(document, operation.objectId) !== undefined) {
    return { ok: false, error: duplicateIdError(operation.objectId) };
  }
  const base = {
    id: operation.objectId,
    transform: structuredClone(operation.transform ?? freshIdentityTransform())
  };
  if (operation.kind === "stroke") {
    document.objects.push({
      ...base,
      kind: "stroke",
      ...(operation.color === undefined ? {} : { color: operation.color }),
      points: structuredClone(operation.points),
      width: operation.width,
      brush: operation.brush,
      lineStyle: operation.lineStyle
    });
  } else if (operation.kind === "box") {
    document.objects.push({ ...base, kind: "box", size: structuredClone(operation.size), ...(operation.color === undefined ? {} : { color: operation.color }) });
  } else if (operation.kind === "text") {
    document.objects.push({ ...base, kind: "text", text: operation.text, ...(operation.color === undefined ? {} : { color: operation.color }) });
  } else {
    return applyPlanarCreate(document, operation, base.transform);
  }
  return { ok: true, inverse: [{ op: "remove", objectIds: [operation.objectId] }] };
}

function applyUpdate(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "update" }>
): OperationOutcome {
  const found = requireKnownKind(document, operation.objectId);
  if ("error" in found) {
    return { ok: false, error: found.error };
  }
  const object = found.object;
  if (object.kind !== operation.kind) {
    return {
      ok: false,
      error: {
        code: "invalid_operation",
        message: `Object "${operation.objectId}" is a ${object.kind}, not a ${operation.kind}`
      }
    };
  }

  if (operation.kind === "stroke" && object.kind === "stroke") {
    const previous: {
      points?: typeof object.points;
      width?: number;
      brush?: typeof object.brush;
      lineStyle?: typeof object.lineStyle;
      color?: string | null;
    } = {};
    if (operation.points !== undefined) {
      previous.points = structuredClone(object.points);
      object.points = structuredClone(operation.points);
    }
    if (operation.width !== undefined) {
      previous.width = object.width;
      object.width = operation.width;
    }
    if (operation.brush !== undefined) {
      previous.brush = object.brush;
      object.brush = operation.brush;
    }
    if (operation.lineStyle !== undefined) {
      previous.lineStyle = object.lineStyle;
      object.lineStyle = operation.lineStyle;
    }
    if (operation.color !== undefined) {
      previous.color = object.color ?? null;
      assignColor(object, operation.color);
    }
    return {
      ok: true,
      inverse: [{ op: "update", objectId: operation.objectId, kind: "stroke", ...previous }]
    };
  }
  if (operation.kind === "box" && object.kind === "box") {
    const previous: { size?: typeof object.size; color?: string | null } = {};
    if (operation.size !== undefined) {
      previous.size = structuredClone(object.size);
      object.size = structuredClone(operation.size);
    }
    if (operation.color !== undefined) {
      previous.color = object.color ?? null;
      assignColor(object, operation.color);
    }
    return {
      ok: true,
      inverse: [{ op: "update", objectId: operation.objectId, kind: "box", ...previous }]
    };
  }
  if ((operation.kind === "planarShape" || operation.kind === "textBox") &&
    (object.kind === "planarShape" || object.kind === "textBox")) {
    return applyPlanarUpdate(object, operation);
  }
  const previous: { text?: string; color?: string | null } = {};
  if (operation.kind === "text" && object.kind === "text") {
    if (operation.text !== undefined) {
      previous.text = object.text;
      object.text = operation.text;
    }
    if (operation.color !== undefined) {
      previous.color = object.color ?? null;
      assignColor(object, operation.color);
    }
  }
  return {
    ok: true,
    inverse: [{ op: "update", objectId: operation.objectId, kind: "text", ...previous }]
  };
}

function assignColor(object: { color?: string }, color: string | null): void {
  if (color === null) {
    delete object.color;
  } else {
    object.color = color;
  }
}

function applyTransform(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "transform" }>
): OperationOutcome {
  const found = requireKnownKind(document, operation.objectId);
  if ("error" in found) {
    return { ok: false, error: found.error };
  }
  const previous = structuredClone(resolveSketchTransform(found.object.transform));
  found.object.transform = structuredClone(operation.transform);
  return {
    ok: true,
    inverse: [{ op: "transform", objectId: operation.objectId, transform: previous }]
  };
}

function applyDelete(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "delete" }>
): OperationOutcome {
  const found = requireKnownKind(document, operation.objectId);
  if ("error" in found) {
    return { ok: false, error: found.error };
  }
  const index = indexSketchObjects(document.objects);
  const removed = subtreeOf(operation.objectId, index).map((object) => structuredClone(object));
  const removedIds = new Set(removed.map((object) => object.id));
  document.objects = document.objects.filter((object) => !removedIds.has(object.id));
  return { ok: true, inverse: [{ op: "restore", objects: removed }] };
}

function applyClear(document: SketchDocument): OperationOutcome {
  if (document.objects.length === 0) {
    return { ok: false, error: { code: "invalid_operation", message: "The sketch is already empty" } };
  }
  const unsupported = document.objects.find((object) => !isKnownSketchObject(object));
  if (unsupported !== undefined) {
    return {
      ok: false,
      error: {
        code: "unsupported_object_kind",
        message: `Object "${unsupported.id}" has unsupported kind "${unsupported.kind}" and cannot be cleared`
      }
    };
  }
  const removed = document.objects.map((object) => structuredClone(object));
  document.objects = [];
  return { ok: true, inverse: [{ op: "restore", objects: removed }] };
}

function applyGroup(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "group" }>
): OperationOutcome {
  if (findObject(document, operation.groupId) !== undefined) {
    return { ok: false, error: duplicateIdError(operation.groupId) };
  }
  const index = indexSketchObjects(document.objects);
  const seenMembers = new Set<string>();
  const inverseAssignments: { objectId: string; parentId: string | null }[] = [];
  for (const memberId of operation.memberIds) {
    if (seenMembers.has(memberId)) {
      return {
        ok: false,
        error: {
          code: "invalid_operation",
          message: `Member id "${memberId}" appears more than once`
        }
      };
    }
    seenMembers.add(memberId);
    const member = index.byId.get(memberId);
    if (member === undefined) {
      return { ok: false, error: unknownObjectError(memberId) };
    }
    const parent = readParentId(member);
    inverseAssignments.push({ objectId: memberId, parentId: parent === undefined ? null : parent });
  }

  if (operation.parentId !== undefined) {
    const parent = index.byId.get(operation.parentId);
    if (parent === undefined) {
      return { ok: false, error: unknownObjectError(operation.parentId) };
    }
    if (parent.kind !== "group") {
      return {
        ok: false,
        error: {
          code: "invalid_operation",
          message: `Group parent "${operation.parentId}" must be a group, not a ${parent.kind}`
        }
      };
    }
    // Nesting the new group under a member (or a descendant of one) would
    // close a cycle: the member would contain its own ancestor.
    for (const memberId of operation.memberIds) {
      if (operation.parentId === memberId || isDescendantOf(operation.parentId, memberId, index)) {
        return {
          ok: false,
          error: {
            code: "group_cycle",
            message: `Group parent "${operation.parentId}" cannot lie inside member "${memberId}"`
          }
        };
      }
    }
  }

  document.objects.push({
    id: operation.groupId,
    kind: "group",
    ...(operation.parentId === undefined ? {} : { parentId: operation.parentId }),
    transform: freshIdentityTransform()
  });
  for (const memberId of operation.memberIds) {
    const member = findObject(document, memberId);
    if (member !== undefined) {
      assignParentId(member, operation.groupId);
    }
  }
  return {
    ok: true,
    inverse: [
      { op: "setParents", assignments: inverseAssignments },
      { op: "remove", objectIds: [operation.groupId] }
    ]
  };
}

function applyUngroup(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "ungroup" }>
): OperationOutcome {
  const group = findObject(document, operation.groupId);
  if (group === undefined) {
    return { ok: false, error: unknownObjectError(operation.groupId) };
  }
  if (group.kind !== "group") {
    return {
      ok: false,
      error: {
        code: "invalid_operation",
        message: `Object "${operation.groupId}" is a ${group.kind}, not a group`
      }
    };
  }
  const shell = structuredClone(group);
  const members = document.objects.filter(
    (object) => readParentId(object) === operation.groupId
  );
  const formerParent = readParentId(group) ?? null;
  for (const member of members) {
    assignParentId(member, formerParent);
  }
  document.objects = document.objects.filter((object) => object.id !== operation.groupId);
  return {
    ok: true,
    inverse: [
      { op: "restore", objects: [shell] },
      {
        op: "setParents",
        assignments: members.map((member) => ({
          objectId: member.id,
          parentId: operation.groupId
        }))
      }
    ]
  };
}

function applyRestore(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "restore" }>
): OperationOutcome {
  for (const object of operation.objects) {
    if (findObject(document, object.id) !== undefined) {
      return { ok: false, error: duplicateIdError(object.id) };
    }
  }
  for (const object of operation.objects) {
    document.objects.push(structuredClone(object));
  }
  return {
    ok: true,
    inverse: [{ op: "remove", objectIds: operation.objects.map((object) => object.id) }]
  };
}

function applyRemove(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "remove" }>
): OperationOutcome {
  const removed: SketchDocument["objects"] = [];
  for (const objectId of operation.objectIds) {
    const object = findObject(document, objectId);
    if (object === undefined) {
      return { ok: false, error: unknownObjectError(objectId) };
    }
    removed.push(structuredClone(object));
  }
  const removedIds = new Set(operation.objectIds);
  document.objects = document.objects.filter((object) => !removedIds.has(object.id));
  return { ok: true, inverse: [{ op: "restore", objects: removed }] };
}

function applySetParents(
  document: SketchDocument,
  operation: Extract<SketchOperation, { op: "setParents" }>
): OperationOutcome {
  const index = indexSketchObjects(document.objects);
  const inverseAssignments: { objectId: string; parentId: string | null }[] = [];
  for (const assignment of operation.assignments) {
    const object = index.byId.get(assignment.objectId);
    if (object === undefined) {
      return { ok: false, error: unknownObjectError(assignment.objectId) };
    }
    if (assignment.parentId !== null && !index.byId.has(assignment.parentId)) {
      return { ok: false, error: unknownObjectError(assignment.parentId) };
    }
    const current = readParentId(object);
    inverseAssignments.push({
      objectId: assignment.objectId,
      parentId: current === undefined ? null : current
    });
  }
  for (const assignment of operation.assignments) {
    const object = findObject(document, assignment.objectId);
    if (object !== undefined) {
      assignParentId(object, assignment.parentId);
    }
  }
  return { ok: true, inverse: [{ op: "setParents", assignments: inverseAssignments }] };
}
