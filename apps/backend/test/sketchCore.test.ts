import { describe, expect, it } from "vitest";
import {
  createSketchState,
  evaluateSketchCommit,
  parseSketchState,
  redoSketchTransaction,
  serializeSketchState,
  sketchCommitRequestSchema,
  undoSketchTransaction,
  type SketchCommitRequest,
  type SketchCoreError,
  type SketchState,
  type SketchTransactionResult
} from "../src/sketch/core";
import { documentWithUnknownObject, FIXTURE_SKETCH_ID, nonPlanarSketchObjects } from "../src/sketch/core/fixtures";

// Evaluator semantics: atomic batches, revisions, idempotency, identity,
// structure, undo/redo head rules, and the caller-state guarantee. Limits
// get their own file; parse/serialize their own.

const human = { kind: "human", name: "Tester" } as const;
const agent = { kind: "agent", runnerId: "cursor", name: "Cursor" } as const;

function commit(
  state: SketchState,
  requestId: string,
  operations: SketchCommitRequest["operations"],
  baseRevision = state.document.revision,
  actor: SketchCommitRequest["actor"] = human
): SketchTransactionResult {
  return evaluateSketchCommit(state, { requestId, baseRevision, actor, operations });
}

function expectError(result: SketchTransactionResult, code: SketchCoreError["code"]): SketchCoreError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.error.code).toBe(code);
  return result.error;
}

function strokeCreate(objectId: string, points: [number, number, number][] = [
  [0, 0, 0],
  [0.1, 0.1, 0.08],
  [0.2, 0.15, -0.08]
]): SketchCommitRequest["operations"][number] {
  return { op: "create", objectId, kind: "stroke", points, width: 0.006 };
}

function objectById(state: SketchState, objectId: string) {
  return state.document.objects.find((object) => object.id === objectId);
}

describe("sketch commit evaluation", () => {
  it("undoes dependent operations in reverse order and preserves each inverse group", () => {
    const initial = createSketchState("batch-undo");
    const committed = commit(initial, "create-group", [
      strokeCreate("s1"),
      { op: "update", objectId: "s1", kind: "stroke", width: 0.01 },
      { op: "group", groupId: "g1", memberIds: ["s1"] }
    ]);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const undone = undoSketchTransaction(committed.state, { requestId: "undo", baseRevision: 1, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.document.objects).toEqual(initial.document.objects);
    const redone = redoSketchTransaction(undone.state, { requestId: "redo", baseRevision: 2, actor: human });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(redone.state.document.objects).toEqual(committed.state.document.objects);
  });

  it("undoes repeated updates to the original value rather than an intermediate value", () => {
    const seeded = commit(createSketchState("updates-undo"), "seed", [strokeCreate("s1")]);
    if (!seeded.ok) throw new Error("fixture failed");
    const committed = commit(seeded.state, "updates", [
      { op: "update", objectId: "s1", kind: "stroke", width: 0.01 },
      { op: "update", objectId: "s1", kind: "stroke", width: 0.02 }
    ]);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const undone = undoSketchTransaction(committed.state, { requestId: "undo", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.state.document.objects).toEqual(seeded.state.document.objects);
  });

  it("stores brush and line style as one update with exact undo and redo", () => {
    const seeded = commit(createSketchState("style-undo"), "seed", [strokeCreate("s1")]);
    if (!seeded.ok) throw new Error("fixture failed");
    const styled = commit(seeded.state, "style", [
      { op: "update", objectId: "s1", kind: "stroke", brush: "broadMarker", lineStyle: "dashed" }
    ]);
    expect(styled.ok).toBe(true);
    if (!styled.ok) return;
    expect(objectById(styled.state, "s1")).toMatchObject({ brush: "broadMarker", lineStyle: "dashed" });

    const undone = undoSketchTransaction(styled.state, { requestId: "undo-style", baseRevision: 2, actor: human });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(objectById(undone.state, "s1")).toMatchObject({ brush: "finePen", lineStyle: "solid" });

    const redone = redoSketchTransaction(undone.state, { requestId: "redo-style", baseRevision: 3, actor: human });
    expect(redone.ok).toBe(true);
    if (redone.ok) expect(objectById(redone.state, "s1")).toMatchObject({ brush: "broadMarker", lineStyle: "dashed" });
  });

  it("stores a translucent highlighter stroke", () => {
    const created = commit(createSketchState("highlighter"), "seed", [
      { ...strokeCreate("s1"), brush: "highlighter", color: "#F9A82566" }
    ]);
    expect(created.ok).toBe(true);
    if (created.ok) expect(objectById(created.state, "s1")).toMatchObject({ brush: "highlighter", color: "#F9A82566" });
  });

  it("refuses an update that names no field for any kind", () => {
    for (const kind of ["stroke", "box", "text", "planarShape", "textBox"] as const) {
      const parsed = sketchCommitRequestSchema.safeParse({
        requestId: `empty-${kind}`,
        baseRevision: 0,
        actor: human,
        operations: [{ op: "update", objectId: "any", kind }]
      });
      expect(parsed.success, kind).toBe(false);
    }
  });

  it("starts empty at revision zero and commits bump the revision once per batch", () => {
    const state = createSketchState("sketch-test-1");
    expect(state.document.revision).toBe(0);
    expect(state.document.objects).toEqual([]);

    const first = commit(state, "r1", [
      strokeCreate("s1"),
      { op: "create", objectId: "b1", kind: "box", size: [0.1, 0.1, 0.1] }
    ]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.document.revision).toBe(1);
    expect(first.receipt).toMatchObject({
      requestId: "r1",
      transactionId: "tx-1",
      revision: 1,
      kind: "commit"
    });
    expect(first.state.document.objects).toHaveLength(2);
  });

  it("applies batches all-or-nothing: a failing operation retracts the whole request", () => {
    const state = createSketchState("sketch-test-2");
    const first = commit(state, "r1", [strokeCreate("s1")]);
    expect(first.ok).toBe(true);
    const seeded = first.ok ? first.state : state;

    const before = structuredClone(seeded);
    const error = expectError(
      commit(seeded, "r2", [
        { op: "create", objectId: "b1", kind: "box", size: [0.1, 0.1, 0.1] },
        // Duplicate id: the whole batch must go, including b1.
        strokeCreate("s1")
      ]),
      "duplicate_object_id"
    );
    expect(error.opIndex).toBe(1);
    expect(seeded).toEqual(before);
  });

  it("leaves the caller's state object untouched on every refusal kind", () => {
    const state = createSketchState("sketch-test-3");
    const seeded = commit(state, "r1", [strokeCreate("s1")]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;
    const before = structuredClone(working);

    expectError(commit(working, "r2", [strokeCreate("s2")], 99), "stale_revision");
    expectError(
      commit(working, "r1", [{ op: "delete", objectId: "s1" }], 1, agent),
      "request_id_conflict"
    );
    expectError(commit(working, "r3", [{ op: "delete", objectId: "nope" }]), "unknown_object");
    expectError(
      commit(working, "r4", [{ op: "transform", objectId: "s1", transform: badTransform() }]),
      "invalid_request"
    );
    expect(working).toEqual(before);
  });

  it("refuses stale base revisions with the current revision attached", () => {
    const state = createSketchState("sketch-test-4");
    const first = commit(state, "r1", [strokeCreate("s1")]);
    expect(first.ok).toBe(true);
    const error = expectError(
      commit(first.ok ? first.state : state, "r2", [strokeCreate("s2")], 0),
      "stale_revision"
    );
    expect(error.currentRevision).toBe(1);
  });

  it("replays an identical retry from the original receipt without reapplying", () => {
    const state = createSketchState("sketch-test-5");
    const first = commit(state, "r1", [strokeCreate("s1")]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const withStroke = first.state;

    // Retry the exact same payload (same base revision) after the fact.
    const retry = evaluateSketchCommit(withStroke, {
      requestId: "r1",
      baseRevision: 0,
      actor: human,
      operations: [strokeCreate("s1")]
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.state).toBe(withStroke);
    expect(withStroke.document.objects).toHaveLength(1);

    // A later commit moves the revision on; the retry still replays.
    const second = commit(withStroke, "r2", [{ op: "delete", objectId: "s1" }]);
    expect(second.ok).toBe(true);
    const lateRetry = evaluateSketchCommit(second.ok ? second.state : withStroke, {
      requestId: "r1",
      baseRevision: 0,
      actor: human,
      operations: [strokeCreate("s1")]
    });
    expect(lateRetry.ok).toBe(true);
    if (lateRetry.ok) {
      expect(lateRetry.receipt.revision).toBe(1);
      expect(lateRetry.state.document.revision).toBe(2);
    }
  });

  it("treats request-id reuse with different input as a conflict", () => {
    const state = createSketchState("sketch-test-6");
    const first = commit(state, "r1", [strokeCreate("s1")]);
    expect(first.ok).toBe(true);
    const withStroke = first.ok ? first.state : state;
    expectError(
      commit(withStroke, "r1", [strokeCreate("s2")], 0),
      "request_id_conflict"
    );
    // Same id on an undo request is a different payload, not a replay.
    expectError(
      undoSketchTransaction(withStroke, { requestId: "r1", baseRevision: 1, actor: human }),
      "request_id_conflict"
    );
  });

  it("rejects unknown target ids and kind mismatches", () => {
    const state = createSketchState("sketch-test-7");
    const seeded = commit(state, "r1", [
      strokeCreate("s1"),
      { op: "create", objectId: "b1", kind: "box", size: [0.1, 0.1, 0.1] }
    ]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;

    expectError(commit(working, "r2", [{ op: "delete", objectId: "ghost" }]), "unknown_object");
    expectError(
      commit(working, "r3", [{ op: "update", objectId: "b1", kind: "stroke", width: 0.01 }]),
      "invalid_operation"
    );
    expectError(commit(working, "r4", [{ op: "ungroup", groupId: "b1" }]), "invalid_operation");
  });

  it("rejects invalid and non-finite transforms at the request boundary", () => {
    const state = createSketchState("sketch-test-8");
    expectError(
      commit(state, "r1", [
        { op: "create", objectId: "b1", kind: "box", size: [1, 1, 1], transform: badTransform() }
      ]),
      "invalid_request"
    );
    expectError(
      commit(state, "r2", [
        {
          op: "create",
          objectId: "b1",
          kind: "box",
          size: [1, 1, 1],
          transform: identityWith({ rotation: [0, 0, 0, Number.NaN] })
        }
      ]),
      "invalid_request"
    );
    expectError(
      commit(state, "r3", [
        {
          op: "create",
          objectId: "b1",
          kind: "box",
          size: [1, 1, 1],
          transform: identityWith({ scale: [0, 1, 1] })
        }
      ]),
      "invalid_request"
    );
    // A normalized non-axis quaternion is fine.
    const ok = commit(state, "r4", [
      {
        op: "create",
        objectId: "b1",
        kind: "box",
        size: [0.1, 0.1, 0.1],
        transform: identityWith({ rotation: [0.5, 0.5, 0.5, 0.5] })
      }
    ]);
    expect(ok.ok).toBe(true);
  });
});

describe("sketch grouping", () => {
  function seededWithGroup(): SketchState {
    const state = createSketchState("sketch-group");
    const result = commit(state, "seed", [
      strokeCreate("s1"),
      { op: "create", objectId: "b1", kind: "box", size: [0.1, 0.1, 0.1] },
      { op: "group", groupId: "g1", memberIds: ["s1", "b1"] }
    ]);
    expect(result.ok).toBe(true);
    return result.ok ? result.state : state;
  }

  it("assigns one parent per member and moves members with the group", () => {
    const working = seededWithGroup();
    expect(objectById(working, "s1")).toMatchObject({ parentId: "g1" });
    expect(objectById(working, "b1")).toMatchObject({ parentId: "g1" });

    const moved = commit(working, "move", [
      {
        op: "transform",
        objectId: "g1",
        transform: identityWith({ translation: [1, 0, 0] })
      }
    ]);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const stroke = objectById(moved.state, "s1");
    expect(stroke).toMatchObject({
      transform: { translation: [0, 0, 0] }
    });
  });

  it("rejects cycles when the new group's parent lies inside its membership", () => {
    const working = seededWithGroup();
    expectError(
      commit(working, "r1", [
        { op: "group", groupId: "g2", memberIds: ["g1"], parentId: "g1" }
      ]),
      "group_cycle"
    );
    // A legal nesting one level down works.
    const nested = commit(working, "r2", [
      { op: "group", groupId: "g2", memberIds: ["g1"], parentId: undefined }
    ]);
    expect(nested.ok).toBe(true);
  });

  it("requires group parents to be groups", () => {
    const working = seededWithGroup();
    expectError(
      commit(working, "r1", [{ op: "group", groupId: "g2", memberIds: ["s1"], parentId: "b1" }]),
      "invalid_operation"
    );
  });

  it("ungroup reparents members upward and restores exactly on undo", () => {
    const state = createSketchState("sketch-ungroup");
    const seeded = commit(state, "seed", [
      strokeCreate("s1"),
      { op: "group", groupId: "g1", memberIds: ["s1"] },
      { op: "group", groupId: "g2", memberIds: ["g1"] }
    ]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;

    const ungrouped = commit(working, "u1", [{ op: "ungroup", groupId: "g2" }]);
    expect(ungrouped.ok).toBe(true);
    if (!ungrouped.ok) return;
    expect(parentIdOf(ungrouped.state, "g1")).toBeUndefined();
    expect(parentIdOf(ungrouped.state, "s1")).toBe("g1");

    const undone = undoSketchTransaction(ungrouped.state, {
      requestId: "u2",
      baseRevision: ungrouped.state.document.revision,
      actor: human
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(objectsById(undone.state)).toEqual(objectsById(working));
    // Seed (1) + ungroup (2) + undo (3): geometry matches the seed two
    // compensating transactions later.
    expect(undone.state.document.revision).toBe(working.document.revision + 2);
  });

  it("deletes a group's whole subtree and restores it exactly on undo", () => {
    const working = seededWithGroup();
    const nested = commit(working, "nest", [
      { op: "create", objectId: "t1", kind: "text", text: "note" },
      { op: "group", groupId: "g2", memberIds: ["t1"], parentId: "g1" }
    ]);
    expect(nested.ok).toBe(true);
    const withSubtree = nested.ok ? nested.state : working;

    const deleted = commit(withSubtree, "d1", [{ op: "delete", objectId: "g1" }]);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.document.objects).toHaveLength(0);

    const undone = undoSketchTransaction(deleted.state, {
      requestId: "d2",
      baseRevision: deleted.state.document.revision,
      actor: human
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    // Undo restores the same objects with the same contents; array order is
    // presentation, not geometry.
    expect(objectsById(undone.state)).toEqual(objectsById(withSubtree));
  });
});

describe("sketch undo and redo", () => {
  it("undoes through compensating transactions at the history head only", () => {
    const state = createSketchState("sketch-undo");
    const drawn = commit(state, "r1", [strokeCreate("s1", [
      [0, 0, 0.1],
      [0.1, 0.2, -0.1],
      [0.2, 0.1, 0.15]
    ])]);
    expect(drawn.ok).toBe(true);
    const withStroke = drawn.ok ? drawn.state : state;

    const moved = commit(withStroke, "r2", [
      {
        op: "transform",
        objectId: "s1",
        transform: identityWith({ translation: [1, 1, 1] })
      }
    ]);
    expect(moved.ok).toBe(true);
    const movedState = moved.ok ? moved.state : withStroke;

    const undoMove = undoSketchTransaction(movedState, {
      requestId: "u1",
      baseRevision: 2,
      actor: human
    });
    expect(undoMove.ok).toBe(true);
    if (!undoMove.ok) return;
    expect(undoMove.receipt).toMatchObject({ kind: "undo", revision: 3, transactionId: "tx-3" });
    expect(undoMove.receipt.label).toBe('Undo "1 operation(s)"');
    expect(objectById(undoMove.state, "s1")).toMatchObject({
      transform: { translation: [0, 0, 0] }
    });
    // Geometry, not snapshot: the stroke's points were never touched.
    expect(objectById(undoMove.state, "s1")).toMatchObject({ width: 0.006 });

    const undoCreate = undoSketchTransaction(undoMove.state, {
      requestId: "u2",
      baseRevision: 3,
      actor: human
    });
    expect(undoCreate.ok).toBe(true);
    if (!undoCreate.ok) return;
    expect(undoCreate.state.document.objects).toHaveLength(0);

    const redoCreate = redoSketchTransaction(undoCreate.state, {
      requestId: "rd1",
      baseRevision: 4,
      actor: human
    });
    expect(redoCreate.ok).toBe(true);
    if (!redoCreate.ok) return;
    expect(redoCreate.state.document.objects).toHaveLength(1);
    expect(objectById(redoCreate.state, "s1")).toMatchObject({
      transform: { translation: [0, 0, 0] }
    });

    const redoMove = redoSketchTransaction(redoCreate.state, {
      requestId: "rd2",
      baseRevision: 5,
      actor: human
    });
    expect(redoMove.ok).toBe(true);
    if (!redoMove.ok) return;
    expect(objectById(redoMove.state, "s1")).toMatchObject({
      transform: { translation: [1, 1, 1] }
    });
  });

  it("makes an earlier action ineligible once a new edit intervenes", () => {
    const state = createSketchState("sketch-undo-intervening");
    const first = commit(state, "r1", [strokeCreate("s1")]);
    const second = commit(first.ok ? first.state : state, "r2", [strokeCreate("s2")]);
    const two = second.ok ? second.state : state;

    const undoSecond = undoSketchTransaction(two, {
      requestId: "u1",
      baseRevision: 2,
      actor: human
    });
    expect(undoSecond.ok).toBe(true);
    const one = undoSecond.ok ? undoSecond.state : two;
    // Undoing removed the second stroke, not the first.
    expect(objectById(one, "s1")).toBeDefined();
    expect(objectById(one, "s2")).toBeUndefined();

    // A fresh commit clears the redo stack: the undone edit is gone.
    const intervenes = commit(one, "r3", [{ op: "delete", objectId: "s1" }]);
    expect(intervenes.ok).toBe(true);
    const afterEdit = intervenes.ok ? intervenes.state : one;
    expectError(
      redoSketchTransaction(afterEdit, {
        requestId: "rd1",
        baseRevision: afterEdit.document.revision,
        actor: human
      }),
      "nothing_to_redo"
    );
  });

  it("reports nothing to undo or redo at the extremes", () => {
    const state = createSketchState("sketch-undo-empty");
    expectError(
      undoSketchTransaction(state, { requestId: "u1", baseRevision: 0, actor: human }),
      "nothing_to_undo"
    );
    expectError(
      redoSketchTransaction(state, { requestId: "rd1", baseRevision: 0, actor: human }),
      "nothing_to_redo"
    );
  });

  it("records actor and turn on transactions for undo display", () => {
    const state = createSketchState("sketch-undo-actor");
    const drawn = commit(state, "r1", [strokeCreate("s1")], 0, agent);
    expect(drawn.ok).toBe(true);
    const withStroke = drawn.ok ? drawn.state : state;

    const undone = undoSketchTransaction(withStroke, {
      requestId: "u1",
      baseRevision: 1,
      actor: human,
      label: "Take back agent edit"
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    // The receipt records who performed the undo; the shuttled history entry
    // keeps the original actor — together they are what an undo
    // confirmation displays.
    expect(undone.receipt.actor).toEqual(human);
    expect(undone.receipt.label).toBe("Take back agent edit");
    const entry = undone.state.history.redo[0];
    expect(entry.actor).toEqual(agent);
    expect(entry.label).toBe("1 operation(s)");
  });
});

describe("sketch clear", () => {
  it("removes every object in one transaction that undo restores and redo repeats", () => {
    const withMore = commit(createSketchState("clearable"), "seed", [
      strokeCreate("s1"),
      strokeCreate("s2"),
      { op: "create", objectId: "t1", kind: "text", text: "note" },
      { op: "group", groupId: "g1", memberIds: ["s1", "s2"] }
    ]);
    expect(withMore.ok).toBe(true);
    if (!withMore.ok) return;
    const before = withMore.state;

    const cleared = commit(before, "clear", [{ op: "clear" }]);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state.document.objects).toEqual([]);
    expect(cleared.state.document.revision).toBe(before.document.revision + 1);
    expect(cleared.state.history.undo).toHaveLength(before.history.undo.length + 1);

    const undone = undoSketchTransaction(cleared.state, {
      requestId: "unclear", baseRevision: cleared.state.document.revision, actor: human
    });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(objectsById(undone.state)).toEqual(objectsById(before));

    const redone = redoSketchTransaction(undone.state, {
      requestId: "reclear", baseRevision: undone.state.document.revision, actor: human
    });
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.state.document.objects).toEqual([]);
  });

  it("refuses an empty sketch and a sketch holding unknown-kind objects", () => {
    expectError(commit(createSketchState("empty"), "clear", [{ op: "clear" }]), "invalid_operation");
    const base = createSketchState(FIXTURE_SKETCH_ID);
    const parsed = parseSketchState(serializeSketchState({ ...base, document: documentWithUnknownObject() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const refused = expectError(commit(parsed.value, "clear", [{ op: "clear" }]), "unsupported_object_kind");
    expect(refused.opIndex).toBe(0);
    expect(parsed.value.document.objects.length).toBeGreaterThan(0);
  });
});

describe("sketch unknown-kind objects", () => {
  function stateWithUnknown(): SketchState {
    const base = createSketchState(FIXTURE_SKETCH_ID);
    const serialized = serializeSketchState({
      ...base,
      document: documentWithUnknownObject()
    });
    const parsed = parseSketchState(serialized);
    expect(parsed.ok).toBe(true);
    return parsed.ok ? parsed.value : base;
  }

  it("refuses direct edits but allows structural group moves", () => {
    const working = stateWithUnknown();
    expectError(
      commit(working, "r1", [{ op: "update", objectId: "fixture-hexahedron", kind: "box", size: [1, 1, 1] }]),
      "unsupported_object_kind"
    );
    expectError(
      commit(working, "r2", [
        { op: "transform", objectId: "fixture-hexahedron", transform: identity() }
      ]),
      "unsupported_object_kind"
    );
    expectError(
      commit(working, "r3", [{ op: "delete", objectId: "fixture-hexahedron" }]),
      "unsupported_object_kind"
    );

    // Moving it under a different group is structural and allowed.
    const regrouped = commit(working, "r4", [
      { op: "group", groupId: "g9", memberIds: ["fixture-hexahedron"] }
    ]);
    expect(regrouped.ok).toBe(true);
    if (!regrouped.ok) return;
    expect(objectById(regrouped.state, "fixture-hexahedron")).toMatchObject({
      parentId: "g9"
    });
    // Deleting the containing group removes it with the subtree; undo
    // restores it byte-for-byte.
    const deleted = commit(regrouped.state, "r5", [{ op: "delete", objectId: "g9" }]);
    expect(deleted.ok).toBe(true);
    const restored = undoSketchTransaction(deleted.ok ? deleted.state : regrouped.state, {
      requestId: "u1",
      baseRevision: deleted.ok ? deleted.state.document.revision : 0,
      actor: human
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(objectById(restored.state, "fixture-hexahedron")).toEqual(
      objectById(regrouped.state, "fixture-hexahedron")
    );
  });
});

describe("sketch non-planar fixture geometry", () => {
  it("carries genuine depth variation across the helix", () => {
    const objects = nonPlanarSketchObjects();
    const stroke = objects.find((object) => object.id === "fixture-helix");
    expect(stroke).toBeDefined();
    if (stroke === undefined || stroke.kind !== "stroke") return;
    const zs = stroke.points.map((point) => point[2]);
    expect(Math.min(...zs)).toBeLessThan(0);
    expect(Math.max(...zs)).toBeGreaterThan(0);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.2);
  });
});

function identity() {
  return { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
}

function identityWith(override: Partial<ReturnType<typeof identity>>) {
  return { ...identity(), ...override };
}

function badTransform() {
  // Norm 2, far outside the normalization tolerance.
  return identityWith({ rotation: [0, 0, 0, 2] });
}

// Object arrays are compared id-keyed: restore may legitimately reorder.
function objectsById(state: SketchState) {
  return [...state.document.objects].sort((a, b) => a.id.localeCompare(b.id));
}

function parentIdOf(state: SketchState, objectId: string): string | undefined {
  const object = state.document.objects.find((candidate) => candidate.id === objectId);
  const raw = (object as { parentId?: unknown } | undefined)?.parentId;
  return typeof raw === "string" ? raw : undefined;
}
