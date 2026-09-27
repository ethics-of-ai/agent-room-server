import { describe, expect, it } from "vitest";
import {
  SKETCH_MAX_BATCH_BYTES,
  SKETCH_MAX_BATCH_OPERATIONS,
  SKETCH_MAX_EXPIRED_REQUEST_IDS,
  SKETCH_MAX_OBJECTS,
  SKETCH_MAX_PATTERN_SEGMENTS,
  SKETCH_MAX_RETAINED_RECEIPTS,
  SKETCH_MAX_STROKE_POINTS,
  SKETCH_MAX_TOTAL_POINTS,
  SKETCH_MAX_UNDO_ENTRIES,
  createSketchState,
  evaluateSketchCommit,
  parseSketchDocument,
  parseSketchState,
  serializeSketchDocument,
  serializeSketchState,
  undoSketchTransaction,
  type SketchCommitRequest,
  type SketchCoreError,
  type SketchState,
  type SketchTransactionResult
} from "../src/sketch/core";

// Every advertised cap, exercised at its edge and one step past it. The
// point is not that a limit exists but that crossing it refuses the batch
// without touching caller state, names the limit, and still accepts the
// at-the-edge case.

const human = { kind: "human" } as const;

function commit(
  state: SketchState,
  requestId: string,
  operations: SketchCommitRequest["operations"]
): SketchTransactionResult {
  return evaluateSketchCommit(state, {
    requestId,
    baseRevision: state.document.revision,
    actor: human,
    operations
  });
}

function expectLimit(result: SketchTransactionResult, limit: string): SketchCoreError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.error.code).toBe("limit_exceeded");
  expect(result.error.limit).toBe(limit);
  return result.error;
}

function expectInvalidRequest(result: SketchTransactionResult): SketchCoreError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.error.code).toBe("invalid_request");
  return result.error;
}

function boxCreate(objectId: string, size: [number, number, number] = [0.1, 0.1, 0.1]) {
  return { op: "create", objectId, kind: "box", size } as const;
}

function linePoints(count: number, coordinate = 0.001): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    points.push([coordinate, coordinate, coordinate]);
  }
  return points;
}

function fillWithBoxes(state: SketchState, count: number, firstIndex = 0): SketchState {
  let working = state;
  // Batches cap at 32 operations, so fill in chunks.
  for (let start = firstIndex; start < firstIndex + count; start += SKETCH_MAX_BATCH_OPERATIONS) {
    const chunk = [];
    for (let i = start; i < Math.min(start + SKETCH_MAX_BATCH_OPERATIONS, firstIndex + count); i += 1) {
      chunk.push(boxCreate(`box-${i}`));
    }
    const result = commit(working, `fill-${start}`, chunk);
    expect(result.ok).toBe(true);
    if (result.ok) {
      working = result.state;
    }
  }
  return working;
}

describe("sketch size limits", () => {
  it("holds 128 objects and refuses the 129th", () => {
    const state = createSketchState("sketch-limits-objects");
    const full = fillWithBoxes(state, SKETCH_MAX_OBJECTS);
    expect(full.document.objects).toHaveLength(SKETCH_MAX_OBJECTS);

    const before = structuredClone(full);
    expectLimit(commit(full, "over", [boxCreate("box-over")]), "objects");
    expect(full).toEqual(before);
  });

  it("accepts a stroke at 2048 points and rejects 2049 at the schema edge", () => {
    const state = createSketchState("sketch-limits-points");
    const atCap = commit(state, "r1", [
      { op: "create", objectId: "s1", kind: "stroke", points: linePoints(SKETCH_MAX_STROKE_POINTS), width: 0.005 }
    ]);
    expect(atCap.ok).toBe(true);

    expectInvalidRequest(
      commit(state, "r2", [
        { op: "create", objectId: "s2", kind: "stroke", points: linePoints(SKETCH_MAX_STROKE_POINTS + 1), width: 0.005 }
      ])
    );
    // A single point is below the minimum, not just over the maximum.
    expectInvalidRequest(
      commit(state, "r3", [
        { op: "create", objectId: "s3", kind: "stroke", points: linePoints(1), width: 0.005 }
      ])
    );
  });

  it("caps total stroke points across the whole document", () => {
    const state = createSketchState("sketch-limits-total");
    const strokes = SKETCH_MAX_TOTAL_POINTS / SKETCH_MAX_STROKE_POINTS;
    const full = fillWithStrokes(state, strokes);
    expect(full.document.objects).toHaveLength(strokes);

    const before = structuredClone(full);
    expectLimit(
      commit(full, "over", [
        { op: "create", objectId: "over", kind: "stroke", points: linePoints(SKETCH_MAX_STROKE_POINTS), width: 0.005 }
      ]),
      "totalPoints"
    );
    expect(full).toEqual(before);
  });

  it("caps patterned mesh segments independently of stored point count", () => {
    const state = createSketchState("sketch-limits-patterns");
    const ordinary = commit(state, "dotted-near-edge", [{
      op: "create",
      objectId: "dotted",
      kind: "stroke",
      points: [[-4.9, 0, 0], [4.9, 0, 0]],
      width: 0.001,
      lineStyle: "dotted"
    }]);
    expect(ordinary.ok).toBe(true);
    expect(SKETCH_MAX_PATTERN_SEGMENTS).toBe(8192);

    const longPath = Array.from({ length: SKETCH_MAX_STROKE_POINTS }, (_, index) => [
      index % 2 === 0 ? -5 : 5,
      0,
      0
    ]) as [number, number, number][];
    expectLimit(commit(state, "dotted-over-budget", [{
      op: "create",
      objectId: "too-many-dots",
      kind: "stroke",
      points: longPath,
      width: 0.001,
      lineStyle: "dotted"
    }]), "patternSegments");
  });

  it("accepts 32 operations per batch and refuses 33", () => {
    const state = createSketchState("sketch-limits-ops");
    const operations = Array.from({ length: SKETCH_MAX_BATCH_OPERATIONS }, (_, i) => boxCreate(`b-${i}`));
    const atCap = commit(state, "r1", operations);
    expect(atCap.ok).toBe(true);

    expectInvalidRequest(commit(state, "r2", [...operations, boxCreate("b-over")]));
  });

  it("refuses batches whose serialized form exceeds 256 KiB", () => {
    const state = createSketchState("sketch-limits-bytes");
    // Nine max-length strokes serialize past the cap; the check fires before
    // any application, so the point-total cap never comes into play.
    const operations = Array.from({ length: 9 }, (_, i) => ({
      op: "create",
      objectId: `fat-${i}`,
      kind: "stroke",
      points: linePoints(SKETCH_MAX_STROKE_POINTS, 1.234567),
      width: 0.005
    })) as SketchCommitRequest["operations"];
    const serialized = Buffer.byteLength(JSON.stringify(operations));
    expect(serialized).toBeGreaterThan(SKETCH_MAX_BATCH_BYTES);

    const before = structuredClone(state);
    expectLimit(commit(state, "r1", operations), "batchBytes");
    expect(state).toEqual(before);
  });

  it("caps text length, stroke width, and box dimensions at the schema edge", () => {
    const state = createSketchState("sketch-limits-fields");
    const text = "x".repeat(1000);
    const atCap = commit(state, "r1", [
      { op: "create", objectId: "t1", kind: "text", text }
    ]);
    expect(atCap.ok).toBe(true);

    expectInvalidRequest(commit(state, "r2", [
      { op: "create", objectId: "t2", kind: "text", text: `${text}x` }
    ]));
    expectInvalidRequest(commit(state, "r3", [
      { op: "create", objectId: "w1", kind: "stroke", points: linePoints(2), width: 0.2000001 }
    ]));
    expectInvalidRequest(commit(state, "r4", [
      { op: "create", objectId: "w2", kind: "stroke", points: linePoints(2), width: 0.0009 }
    ]));
    expectInvalidRequest(commit(state, "r5", [boxCreate("b1", [10.0001, 0.1, 0.1])]));
    expectInvalidRequest(commit(state, "r6", [boxCreate("b1", [0.0009, 0.1, 0.1])]));
  });
});

describe("sketch transform and coordinate limits", () => {
  it("keeps raw coordinates inside the 10-meter cube, faces inclusive", () => {
    const state = createSketchState("sketch-limits-cube");
    // A 0.1 m box centered at 4.95 reaches exactly 5.0 on each face.
    const atFace = commit(state, "r1", [
      {
        op: "create",
        objectId: "b1",
        kind: "box",
        size: [0.1, 0.1, 0.1],
        transform: {
          translation: [4.95, -4.95, 4.95],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        }
      }
    ]);
    expect(atFace.ok).toBe(true);

    expectInvalidRequest(commit(state, "r2", [
      {
        op: "create",
        objectId: "b2",
        kind: "box",
        size: [0.1, 0.1, 0.1],
        transform: {
          translation: [5.001, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        }
      }
    ]));
  });

  it("refuses transforms that push geometry out of the cube", () => {
    const state = createSketchState("sketch-limits-escape");
    const seeded = commit(state, "r1", [
      {
        op: "create",
        objectId: "b1",
        kind: "box",
        size: [2, 2, 2],
        transform: {
          translation: [4, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        }
      }
    ]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;
    const before = structuredClone(working);

    const error = expectError(
      commit(working, "r2", [
        {
          op: "transform",
          objectId: "b1",
          transform: {
            translation: [4.6, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1]
          }
        }
      ]),
      "out_of_bounds"
    );
    expect(error.opIndex).toBe(0);
    expect(working).toEqual(before);
  });

  it("checks composed group transforms, not just raw coordinates", () => {
    const state = createSketchState("sketch-limits-composed");
    const seeded = commit(state, "r1", [
      {
        op: "create",
        objectId: "b1",
        kind: "box",
        size: [1, 1, 1],
        transform: {
          translation: [2, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        }
      },
      { op: "group", groupId: "g1", memberIds: ["b1"] }
    ]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;

    // Scaling the parent carries the child's corner past the face even
    // though the child's own coordinates never change: at 2.0 the corner
    // lands exactly on the face, at 2.1 it escapes.
    const error = expectError(
      commit(working, "r2", [
        {
          op: "transform",
          objectId: "g1",
          transform: {
            translation: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [2.1, 1, 1]
          }
        }
      ]),
      "out_of_bounds"
    );
    expect(error.opIndex).toBe(0);
    // Just inside stays legal.
    const inside = commit(working, "r3", [
      {
        op: "transform",
        objectId: "g1",
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [2, 1, 1]
        }
      }
    ]);
    expect(inside.ok).toBe(true);
  });

  it("bounds scale to [0.001, 100] and rejects non-normalized quaternions", () => {
    const state = createSketchState("sketch-limits-transform");
    const atCap = commit(state, "r1", [
      {
        op: "create",
        objectId: "b1",
        kind: "box",
        size: [0.01, 0.01, 0.01],
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [100, 0.001, 1]
        }
      }
    ]);
    expect(atCap.ok).toBe(true);

    for (const scale of [[100.1, 1, 1], [0.0009, 1, 1]] as [number, number, number][]) {
      expectInvalidRequest(commit(state, "r2", [
        {
          op: "create",
          objectId: "b2",
          kind: "box",
          size: [0.01, 0.01, 0.01],
          transform: {
            translation: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale
          }
        }
      ]));
    }
    expectInvalidRequest(commit(state, "r3", [
      {
        op: "create",
        objectId: "b3",
        kind: "box",
        size: [0.01, 0.01, 0.01],
        transform: {
          translation: [0, 0, 0],
          rotation: [1, 0, 0, 1],
          scale: [1, 1, 1]
        }
      }
    ]));
  });

  it("allows four group levels and refuses the fifth", () => {
    const state = createSketchState("sketch-limits-depth");
    const seeded = commit(state, "r1", [
      boxCreate("b1"),
      { op: "group", groupId: "g1", memberIds: ["b1"] },
      { op: "group", groupId: "g2", memberIds: ["g1"] },
      { op: "group", groupId: "g3", memberIds: ["g2"] },
      { op: "group", groupId: "g4", memberIds: ["g3"] }
    ]);
    expect(seeded.ok).toBe(true);
    const working = seeded.ok ? seeded.state : state;
    const before = structuredClone(working);

    expectLimit(commit(working, "r2", [
      { op: "group", groupId: "g5", memberIds: ["g4"] }
    ]), "groupDepth");
    expect(working).toEqual(before);
  });
});

describe("sketch retention limits", () => {
  it("trims undo history to 50 entries without discarding geometry", () => {
    const state = createSketchState("sketch-limits-undo");
    let working = state;
    for (let i = 0; i < SKETCH_MAX_UNDO_ENTRIES + 10; i += 1) {
      const result = commit(working, `r-${i}`, [boxCreate(`box-${i}`)]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        working = result.state;
      }
    }
    expect(working.document.objects).toHaveLength(SKETCH_MAX_UNDO_ENTRIES + 10);
    expect(working.history.undo).toHaveLength(SKETCH_MAX_UNDO_ENTRIES);

    // Undo drains the retained window to empty; the oldest commits are
    // simply gone, and the geometry they created is untouched.
    let draining = working;
    for (let i = 0; i < SKETCH_MAX_UNDO_ENTRIES; i += 1) {
      const undone = undoSketchTransaction(draining, {
        requestId: `u-${i}`,
        baseRevision: draining.document.revision,
        actor: human
      });
      expect(undone.ok).toBe(true);
      if (undone.ok) {
        draining = undone.state;
      }
    }
    expect(draining.document.objects).toHaveLength(10);
    const exhausted = undoSketchTransaction(draining, {
      requestId: "u-final",
      baseRevision: draining.document.revision,
      actor: human
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.error.code).toBe("nothing_to_undo");
    }
  });

  it("retains at most 256 receipts, and an evicted retry answers outcome_unknown", () => {
    const state = createSketchState("sketch-limits-receipts");
    let working = state;
    for (let i = 0; i < SKETCH_MAX_RETAINED_RECEIPTS + 1; i += 1) {
      // Alternate create/delete on one object: many transactions without
      // approaching the object cap.
      const operations = i % 2 === 0 ? [boxCreate("solo")] : [{ op: "delete", objectId: "solo" } as const];
      const result = commit(working, `r-${i}`, operations);
      expect(result.ok).toBe(true);
      if (result.ok) {
        working = result.state;
      }
    }
    expect(working.receipts).toHaveLength(SKETCH_MAX_RETAINED_RECEIPTS);
    expect(working.receipts.map((receipt) => receipt.requestId)).not.toContain("r-0");
    expect(working.expiredRequestIds).toContain("r-0");

    // The evicted request id cannot be replayed (its fingerprint left with the
    // receipt) and must not re-execute (it may already have committed), so the
    // retry hears the explicit outcome-unknown refusal — never a blind replay
    // and never a re-send invitation through the stale-revision path.
    const evicted = evaluateSketchCommit(working, {
      requestId: "r-0",
      baseRevision: 0,
      actor: human,
      operations: [boxCreate("solo")]
    });
    expect(evicted.ok).toBe(false);
    if (!evicted.ok) {
      expect(evicted.error.code).toBe("outcome_unknown");
      expect(evicted.error.currentRevision).toBe(working.document.revision);
    }

    // A receipt still inside the window keeps replaying exactly, and the
    // expiry ring itself stays bounded.
    const live = evaluateSketchCommit(working, {
      requestId: `r-${SKETCH_MAX_RETAINED_RECEIPTS - 1}`,
      baseRevision: SKETCH_MAX_RETAINED_RECEIPTS - 1,
      actor: human,
      operations: [{ op: "delete", objectId: "solo" }]
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.receipt.requestId).toBe(`r-${SKETCH_MAX_RETAINED_RECEIPTS - 1}`);
      expect(live.state).toBe(working);
    }
    expect(working.expiredRequestIds.length).toBeLessThanOrEqual(SKETCH_MAX_EXPIRED_REQUEST_IDS);
  });

  it("bounds the expired-request ring at 1024 ids, dropping the oldest", () => {
    const state = createSketchState("sketch-limits-expired-ring");
    let working = state;
    // 2 * (1024 + 8) transactions alternate create/delete on one object id.
    const transactions = 2 * (SKETCH_MAX_EXPIRED_REQUEST_IDS + 8);
    for (let i = 0; i < transactions; i += 1) {
      const operations = i % 2 === 0 ? [boxCreate("solo")] : [{ op: "delete", objectId: "solo" } as const];
      const result = commit(working, `r-${i}`, operations);
      expect(result.ok).toBe(true);
      if (result.ok) {
        working = result.state;
      }
    }
    expect(working.expiredRequestIds).toHaveLength(SKETCH_MAX_EXPIRED_REQUEST_IDS);
    expect(working.expiredRequestIds).not.toContain("r-0");
    expect(working.expiredRequestIds).toContain(`r-${transactions - 2 * SKETCH_MAX_RETAINED_RECEIPTS - 1}`);

    // The dropped ids are ordinary unseen request ids again: with the current
    // revision they apply like any fresh request, not an expiry refusal.
    const forgotten = evaluateSketchCommit(working, {
      requestId: "r-0",
      baseRevision: working.document.revision,
      actor: human,
      operations: [boxCreate("solo")]
    });
    expect(forgotten.ok).toBe(true);
  });

  // Building and parsing over 2 MiB of history takes about 2.5 s on a fast Mac
  // and can pass vitest's 5 s default on a shared CI runner.
  it("round-trips a state whose retained history exceeds the document cap", () => {
    const state = createSketchState("sketch-limits-fat-history");
    // Alternate full-length stroke create/delete: the document never holds
    // more than one stroke (so the 16,384-point and 2 MiB document caps hold),
    // while the retained undo entries accumulate past the 2 MiB document cap
    // inside their own 8 MiB budget. A state parse that applied the document
    // cap would reject the very history the evaluator is allowed to keep.
    let working = state;
    // 40 transactions: 20 three-stroke creates (~123 KB of forward ops each,
    // well under the 16,384-point document cap of 6,144 at a time) plus 20
    // near-empty deletes, all inside the 50-entry undo window.
    for (let i = 0; i < 40; i += 1) {
      const operations = i % 2 === 0
        ? [0, 1, 2].map((slot) => ({
            op: "create",
            objectId: `solo-${slot}`,
            kind: "stroke",
            points: linePoints(SKETCH_MAX_STROKE_POINTS),
            width: 0.005
          }))
        : [0, 1, 2].map((slot) => ({ op: "delete", objectId: `solo-${slot}` }) as const);
      const result = commit(working, `fat-${i}`, operations);
      expect(result.ok).toBe(true);
      if (result.ok) {
        working = result.state;
      }
    }
    const historyBytes = Buffer.byteLength(JSON.stringify(working.history));
    expect(historyBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(working.history.undo).toHaveLength(40);

    const parsed = parseSketchState(serializeSketchState(working));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.document.revision).toBe(working.document.revision);
      expect(parsed.value.history.undo).toHaveLength(working.history.undo.length);
      expect(parsed.value.expiredRequestIds).toEqual([]);
    }
  }, 30_000);
});

describe("sketch stored-document size limit", () => {
  it("rejects documents over 2 MiB at parse", () => {
    const oversized = {
      schemaVersion: 1,
      kind: "sketch",
      sketchId: "sketch-limits-doc",
      revision: 1,
      objects: [
        {
          id: "blob",
          kind: "future-blob",
          payload: "x".repeat(3 * 1024 * 1024)
        }
      ]
    };
    const serialized = JSON.stringify(oversized);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(2 * 1024 * 1024);
    const parsed = parseSketchDocument(serialized);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("invalid_document");
      expect(parsed.error.message).toContain("bytes");
    }

    // The same document under the cap parses and preserves the unknown kind.
    const small = {
      ...oversized,
      objects: [{ id: "blob", kind: "future-blob", payload: "x".repeat(1024) }]
    };
    const smallParsed = parseSketchDocument(JSON.stringify(small));
    expect(smallParsed.ok).toBe(true);
    if (smallParsed.ok) {
      expect(serializeSketchDocument(smallParsed.value)).toContain("future-blob");
    }
  });
});

function fillWithStrokes(state: SketchState, count: number): SketchState {
  let working = state;
  for (let i = 0; i < count; i += 1) {
    const result = commit(working, `stroke-${i}`, [
      {
        op: "create",
        objectId: `s-${i}`,
        kind: "stroke",
        points: linePoints(SKETCH_MAX_STROKE_POINTS),
        width: 0.005
      }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      working = result.state;
    }
  }
  return working;
}

function expectError(result: SketchTransactionResult, code: SketchCoreError["code"]): SketchCoreError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.error.code).toBe(code);
  return result.error;
}
