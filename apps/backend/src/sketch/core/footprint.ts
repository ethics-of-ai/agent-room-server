import { ancestorIds, indexSketchObjects, readParentId, subtreeOf } from "./geometry";
import type { SketchDocument, SketchOperation } from "./schemas";

// Which object ids an operation reads and writes. The relaxed revision rule
// and the revision log both come from this one function, so a commit, undo,
// or redo is checked against exactly the ids a later transaction recorded.
//
// The footprint is taken from the document as it stands just before the
// operation applies. That is how the implicit dependencies get in: a group
// delete writes its whole current subtree, a transform reads its parent chain
// (the transform is parent-relative), and group and ungroup read the parent
// the members move under. `all` marks an operation that touches every object.

export interface SketchFootprint {
  all: boolean;
  reads: Set<string>;
  writes: Set<string>;
}

export function emptySketchFootprint(): SketchFootprint {
  return { all: false, reads: new Set(), writes: new Set() };
}

export function addOperationFootprint(
  footprint: SketchFootprint,
  document: SketchDocument,
  operation: SketchOperation
): void {
  const read = (id: string | null | undefined) => { if (id) footprint.reads.add(id); };
  const write = (id: string) => footprint.writes.add(id);
  switch (operation.op) {
    case "create":
    case "update":
      write(operation.objectId);
      return;
    case "transform": {
      write(operation.objectId);
      for (const ancestor of ancestorIds(operation.objectId, indexSketchObjects(document.objects))) read(ancestor);
      return;
    }
    case "delete": {
      write(operation.objectId);
      for (const object of subtreeOf(operation.objectId, indexSketchObjects(document.objects))) write(object.id);
      return;
    }
    case "clear":
      footprint.all = true;
      return;
    case "group": {
      write(operation.groupId);
      read(operation.parentId);
      for (const memberId of operation.memberIds) {
        write(memberId);
        read(parentOf(document, memberId));
      }
      return;
    }
    case "ungroup": {
      write(operation.groupId);
      read(parentOf(document, operation.groupId));
      for (const object of document.objects) {
        if (readParentId(object) === operation.groupId) write(object.id);
      }
      return;
    }
    case "restore":
      for (const object of operation.objects) {
        write(object.id);
        read(readParentId(object));
      }
      return;
    case "remove":
      for (const objectId of operation.objectIds) write(objectId);
      return;
    case "setParents":
      for (const assignment of operation.assignments) {
        write(assignment.objectId);
        read(assignment.parentId);
        read(parentOf(document, assignment.objectId));
      }
      return;
  }
}

// The ids an operation names, without looking at any document. Used to tell
// a refusal caused by a later transaction (the object it names was deleted
// or regrouped) apart from an ordinary invalid operation.
export function namedOperationIds(operation: SketchOperation): string[] {
  switch (operation.op) {
    case "create":
    case "update":
    case "transform":
    case "delete":
      return [operation.objectId];
    case "clear":
      return [];
    case "group":
      return [operation.groupId, ...operation.memberIds, ...(operation.parentId ? [operation.parentId] : [])];
    case "ungroup":
      return [operation.groupId];
    case "restore":
      return operation.objects.map((object) => object.id);
    case "remove":
      return [...operation.objectIds];
    case "setParents":
      return operation.assignments.flatMap((assignment) =>
        assignment.parentId === null ? [assignment.objectId] : [assignment.objectId, assignment.parentId]);
  }
}

function parentOf(document: SketchDocument, objectId: string): string | undefined {
  const object = document.objects.find((candidate) => candidate.id === objectId);
  return object === undefined ? undefined : readParentId(object);
}
