import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SKETCH_MAX_REVISION_LOG_ENTRIES,
  SKETCH_MAX_REVISION_LOG_IDS,
  createSketchState,
  evaluateSketchCommit,
  parseSketchState,
  redoSketchTransaction,
  serializeSketchState,
  sketchStateSchema,
  undoSketchTransaction,
  type SketchActor,
  type SketchCommitRequest,
  type SketchCoreError,
  type SketchState,
  type SketchTransactionResult
} from "../src/sketch/core";

// The relaxed revision rule: a request built on an older revision applies
// when no later revision touched an id it reads or writes.

const human: SketchActor = { kind: "human" };
const agent: SketchActor = { kind: "agent", runnerId: "codex" };
type Operation = SketchCommitRequest["operations"][number];

const box = (objectId: string): Operation => ({ op: "create", objectId, kind: "box", size: [0.1, 0.1, 0.1] });
const resize = (objectId: string, edge = 0.2): Operation => ({ op: "update", objectId, kind: "box", size: [edge, edge, edge] });
const move = (objectId: string, x: number): Operation => ({
  op: "transform", objectId, transform: { translation: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
});

let counter = 0;
function commit(state: SketchState, operations: Operation[], baseRevision = state.document.revision, actor = human): SketchTransactionResult {
  return evaluateSketchCommit(state, { requestId: `r${counter++}`, baseRevision, actor, operations, ...(actor.kind === "agent" ? { turnId: "turn-1" } : {}) });
}
function undo(state: SketchState, baseRevision = state.document.revision, actor = human): SketchTransactionResult {
  return undoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision, actor });
}
function redo(state: SketchState, baseRevision = state.document.revision, actor = human): SketchTransactionResult {
  return redoSketchTransaction(state, { requestId: `r${counter++}`, baseRevision, actor });
}
function ok(result: SketchTransactionResult): SketchState {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}
function refused(result: SketchTransactionResult, code: SketchCoreError["code"] = "stale_revision"): SketchCoreError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe(code);
  return result.error;
}
/** A state with boxes a, b and c at revision 1. */
function seeded(): SketchState {
  return ok(commit(createSketchState("concurrency"), [box("a"), box("b"), box("c")]));
}

describe("relaxed revision rule", () => {
  it("applies a stale request whose ids no later revision touched", () => {
    const base = seeded();
    const later = ok(commit(base, [resize("a")], 1, agent));
    const result = ok(commit(later, [resize("b", 0.3)], 1));
    expect(result.document.revision).toBe(3);
    expect(result.document.objects.find((object) => object.id === "a")).toMatchObject({ size: [0.2, 0.2, 0.2] });
    expect(result.document.objects.find((object) => object.id === "b")).toMatchObject({ size: [0.3, 0.3, 0.3] });
  });

  it("refuses a stale request that overlaps a later revision and names the ids", () => {
    const later = ok(commit(seeded(), [resize("a"), resize("b")], 1, agent));
    const error = refused(commit(later, [resize("b", 0.3), resize("c", 0.3)], 1));
    expect(error).toMatchObject({ currentRevision: 2, conflictingObjectIds: ["b"] });
  });

  it("treats a later delete of a named object as a conflict, not an unknown object", () => {
    const later = ok(commit(seeded(), [{ op: "delete", objectId: "a" }], 1, agent));
    expect(refused(commit(later, [move("a", 1)], 1)).conflictingObjectIds).toEqual(["a"]);
    // Without a later revision the same request is an ordinary refusal.
    refused(commit(later, [move("a", 1)]), "unknown_object");
  });

  it("covers a group delete's whole subtree, including members added later", () => {
    const grouped = ok(commit(seeded(), [{ op: "group", groupId: "g", memberIds: ["a"] }]));
    // An agent moves b into the group; a person deletes the group from the older base.
    const regrouped = ok(commit(grouped, [{ op: "group", groupId: "h", memberIds: ["b"], parentId: "g" }], 2, agent));
    const error = refused(commit(regrouped, [{ op: "delete", objectId: "g" }], 2));
    expect(error.conflictingObjectIds).toEqual(["b", "h"]);
  });

  it("treats group membership changes as touching the members and the parent", () => {
    const grouped = ok(commit(seeded(), [{ op: "group", groupId: "g", memberIds: ["a"] }]));
    const ungrouped = ok(commit(grouped, [{ op: "ungroup", groupId: "g" }], 2, agent));
    // Moving a member reads nothing an ungroup left alone except the member itself.
    expect(refused(commit(ungrouped, [move("a", 1)], 2)).conflictingObjectIds).toEqual(["a"]);
    expect(ok(commit(ungrouped, [move("c", 1)], 2)).document.revision).toBe(4);
  });

  it("reads a transform's parent chain, so moving a group conflicts with moving its member", () => {
    const grouped = ok(commit(seeded(), [{ op: "group", groupId: "g", memberIds: ["a"] }]));
    const moved = ok(commit(grouped, [move("g", 2)], 2, agent));
    expect(refused(commit(moved, [move("a", 1)], 2)).conflictingObjectIds).toEqual(["g"]);
  });

  it("refuses every stale request after a clear, and a stale clear after any change", () => {
    const cleared = ok(commit(seeded(), [{ op: "clear" }], 1, agent));
    expect(cleared.revisionLog?.entries.at(-1)).toEqual({ revision: 2, all: true });
    expect(refused(commit(cleared, [box("d")], 1)).conflictingObjectIds).toEqual([]);

    const changed = ok(commit(seeded(), [resize("a")], 1, agent));
    expect(refused(commit(changed, [{ op: "clear" }], 1)).conflictingObjectIds).toEqual(["a"]);
  });

  it("logs a transaction that changed more ids than an entry holds as touching everything", () => {
    const ids = Array.from({ length: SKETCH_MAX_REVISION_LOG_IDS + 1 }, (_, index) => `x${index}`);
    let state = createSketchState("wide");
    for (let start = 0; start < ids.length; start += 32) state = ok(commit(state, ids.slice(start, start + 32).map(box)));
    const wide = ok(commit(state, [{ op: "group", groupId: "everything", memberIds: ids }], state.document.revision, agent));
    expect(wide.revisionLog?.entries.at(-1)).toEqual({ revision: wide.document.revision, all: true });
    refused(commit(wide, [box("unrelated")], state.document.revision));
  });

  it("refuses a base older than the log's floor", () => {
    let state = createSketchState("long");
    state = ok(commit(state, [box("a")]));
    for (let index = 0; index < SKETCH_MAX_REVISION_LOG_ENTRIES; index++) state = ok(commit(state, [resize("a", 0.1 + (index % 2) * 0.1)]));
    expect(state.revisionLog?.entries).toHaveLength(SKETCH_MAX_REVISION_LOG_ENTRIES);
    expect(state.revisionLog?.floor).toBe(1);
    expect(ok(commit(state, [box("b")], 1)).document.revision).toBe(state.document.revision + 1);
    expect(refused(commit(state, [box("b")], 0)).conflictingObjectIds).toBeUndefined();
  });

  it("keeps the strict rule for a state that has no log", () => {
    const withLog = ok(commit(seeded(), [resize("a")], 1, agent));
    const withoutLog = structuredClone(withLog);
    delete withoutLog.revisionLog;
    refused(commit(withoutLog, [resize("b")], 1));
    // The next current-base commit starts a log at the revision it found.
    const restarted = ok(commit(withoutLog, [resize("b")]));
    expect(restarted.revisionLog).toEqual({ floor: 2, entries: [{ revision: 3, objectIds: ["b"] }] });
    refused(commit(restarted, [resize("c")], 1));
    expect(ok(commit(restarted, [resize("c")], 2)).document.revision).toBe(4);
  });

  it("undoes across another actor's disjoint commit and refuses an overlapping one", () => {
    const mine = ok(commit(seeded(), [resize("a")]));
    const theirs = ok(commit(mine, [resize("c")], 2, agent));
    // Undo is global: the head is the agent's commit, so a person's undo from
    // revision 2 would reverse a step they never saw. It overlaps and is refused.
    expect(refused(undo(theirs, 2)).conflictingObjectIds).toEqual(["c"]);
    // The agent undoes its own step; the person's stale undo then reverses theirs.
    const agentUndone = ok(undo(theirs, 3, agent));
    const personUndone = ok(undo(agentUndone, 2));
    expect(personUndone.document.objects.find((object) => object.id === "a")).toMatchObject({ size: [0.1, 0.1, 0.1] });
    expect(personUndone.document.objects.find((object) => object.id === "c")).toMatchObject({ size: [0.1, 0.1, 0.1] });
  });

  it("redoes from a stale base when the later revisions left the redo head alone, and refuses when they did not", () => {
    // A person changes a, an agent changes c, each undoes their own step.
    const twoSteps = ok(commit(ok(commit(seeded(), [resize("a")])), [resize("c")], 2, agent));
    const agentUndone = ok(undo(twoSteps, 3, agent));
    const personUndone = ok(undo(agentUndone, 4));
    // The redo head is the person's change to a. The person redoes it from
    // revision 4, before their own undo landed in their view: refused, since
    // that undo touched a.
    expect(refused(redo(personUndone, 4)).conflictingObjectIds).toEqual(["a"]);
    // From the current revision it applies.
    const redone = ok(redo(personUndone, 5));
    expect(redone.document.objects.find((object) => object.id === "a")).toMatchObject({ size: [0.2, 0.2, 0.2] });
    // A commit clears redo, whoever makes it.
    refused(redo(ok(commit(personUndone, [resize("b")], 5, agent)), 5), "nothing_to_redo");
  });

  it("interleaves human and agent actors on one document with receipts and history intact", () => {
    let state = seeded();
    const base = state.document.revision;
    state = ok(commit(state, [resize("a")], base, agent));
    state = ok(commit(state, [resize("b")], base, human));
    state = ok(commit(state, [move("c", 1)], base, agent));
    expect(state.document.revision).toBe(4);
    expect(state.history.undo.map((entry) => [entry.actor.kind, entry.turnId ?? null])).toEqual([
      ["human", null], ["agent", "turn-1"], ["human", null], ["agent", "turn-1"]
    ]);
    expect(state.receipts.slice(-3).map((receipt) => receipt.actor.kind)).toEqual(["agent", "human", "agent"]);
    expect(state.revisionLog?.entries.map((entry) => "objectIds" in entry ? entry.objectIds : "all"))
      .toEqual([["a", "b", "c"], ["a"], ["b"], ["c"]]);
    // A person's undo reverses the agent's newest step like any other.
    const undone = ok(undo(state));
    expect(undone.document.objects.find((object) => object.id === "c")).toMatchObject({ transform: { translation: [0, 0, 0] } });
    expect(undone.history.redo.at(-1)?.actor).toEqual(agent);
  });
});

describe("revision log storage", () => {
  it("round-trips through state serialization", () => {
    const state = ok(commit(seeded(), [resize("a")], 1, agent));
    const parsed = parseSketchState(serializeSketchState(state));
    expect(parsed.ok && parsed.value.revisionLog).toEqual(state.revisionLog);
  });

  it("is dropped, with nothing else lost, by a parser that predates it", () => {
    const state = ok(commit(seeded(), [resize("a")], 1, agent));
    // Repository state is stored as a journal envelope. The older envelope
    // parser lists its keys and zod drops the rest, so the log never reaches
    // the older strict state schema.
    const olderEnvelope = z.object({
      fileVersion: z.string(), history: z.unknown(), receipts: z.unknown(), expiredRequestIds: z.unknown().optional()
    });
    const record = { fileVersion: "v", history: state.history, receipts: state.receipts,
      expiredRequestIds: state.expiredRequestIds, revisionLog: state.revisionLog };
    const envelope = olderEnvelope.parse(JSON.parse(JSON.stringify(record)));
    expect(envelope).not.toHaveProperty("revisionLog");
    const olderState = sketchStateSchema.omit({ revisionLog: true }).strict();
    const rebuilt = olderState.safeParse({ ...structuredClone(createSketchState(state.sketchId)),
      document: state.document, history: envelope.history, receipts: envelope.receipts, expiredRequestIds: envelope.expiredRequestIds });
    expect(rebuilt.success).toBe(true);
    if (rebuilt.success) expect(rebuilt.data.history).toEqual(state.history);
    // A whole serialized state is another matter: the strict older schema
    // refuses it. Nothing persists repository state in that form.
    expect(olderState.safeParse(JSON.parse(serializeSketchState(state))).success).toBe(false);
  });
});
