import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableAgentSessionDocument } from "../src/domain/models";
import type { ThreadPlan } from "../src/plans/planModel";
import { ThreadPlanService, durablePlanDocumentWriter } from "../src/plans/ThreadPlanService";
import { DurableAgentSessionStore, type DurableSessionFileSystem } from "../src/state/DurableAgentSessionStore";
import {
  call,
  errorCode,
  liveTurn,
  memoryPlanWriter,
  nextOperationId,
  okPlan,
  planService,
  sequentialIds
} from "./support/planServiceHarness";

const SESSION = "agent-session-1";
const target = (plan: ThreadPlan) => ({ planId: plan.id, expectedRevision: plan.revision });
const createInput = (operationId = nextOperationId()) => ({
  operationId, objective: "Ship it", completionCriteria: "Done", steps: [{ description: "One" }, { description: "Two" }]
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("plan receipts and retries", () => {
  it("replays a duplicate without a new revision and refuses a changed payload", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const input = createInput("op-dup");
    const first = await call(service, turn, "plans.create", input);
    const again = await call(service, turn, "plans.create", input);
    expect(again).toMatchObject({ ok: true, replayed: true, appliedPlanId: okPlan(first).id, appliedRevision: 1 });
    expect(memory.committed).toHaveLength(1);
    const changed = await call(service, turn, "plans.create", { ...input, objective: "Different" });
    expect(errorCode(changed)).toBe("operation_conflict");
  });

  it("evicts old receipts and refuses their retry against advanced state", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const createOp = createInput("op-first");
    let plan = okPlan(await call(service, turn, "plans.create", createOp));
    const editOps: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 64; index += 1) {
      const op = {
        operationId: `op-edit-${index}`, ...target(plan), objective: plan.objective, completionCriteria: plan.completionCriteria,
        steps: plan.steps.map((step, position) => ({ id: step.id, description: position === 1 ? `Two v${index}` : step.description }))
      };
      editOps.push(op);
      plan = okPlan(await call(service, turn, "plans.edit", op));
    }
    expect(service.persistedState(SESSION).planMutationReceipts).toHaveLength(64);
    expect(service.persistedState(SESSION).planMutationReceipts.some((entry) => entry.operationId === "op-first")).toBe(false);
    expect(errorCode(await call(service, turn, "plans.create", createOp))).toBe("plan_conflict");
    const retained = await call(service, turn, "plans.edit", editOps[0]!);
    expect(retained).toMatchObject({ ok: true, replayed: true, appliedRevision: 2 });
  });

  it("serializes simultaneous mutations at the same revision", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(service, turn, "plans.create", createInput()));
    const [left, right] = await Promise.all([
      call(service, turn, "plans.execute", { operationId: "op-left", ...target(plan) }),
      call(service, turn, "plans.execute", { operationId: "op-right", ...target(plan) })
    ]);
    expect([left.ok, right.ok].sort()).toEqual([false, true]);
    expect(errorCode(left.ok ? right : left)).toBe("plan_conflict");
  });

  it("keeps the old plan after a failed write and accepts the retry", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(service, turn, "plans.create", createInput()));
    memory.force("not_committed");
    const op = { operationId: "op-retry", ...target(plan) };
    const failed = await call(service, turn, "plans.execute", op);
    expect(failed).toMatchObject({ ok: false, error: { code: "persistence_failed" }, plan: { revision: 1, status: "draft" } });
    expect(okPlan(await call(service, turn, "plans.execute", op))).toMatchObject({ revision: 2, status: "running" });
  });

  it("reports outcome_unknown until reconciliation, then replays the original operation", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(service, turn, "plans.create", createInput()));
    memory.force("unknown");
    const op = { operationId: "op-unknown", ...target(plan) };
    expect(await call(service, turn, "plans.execute", op)).toMatchObject({ ok: false, error: { code: "outcome_unknown" }, plan: null });
    expect(errorCode(await call(service, turn, "plans.get", {}))).toBe("outcome_unknown");
    expect(await service.read(SESSION)).toEqual({ kind: "unavailable" });
    expect(await service.prepareForTurn(SESSION)).toBe(false);
    memory.reconcileAs(true);
    expect(await call(service, turn, "plans.execute", op)).toMatchObject({ ok: true, replayed: true, appliedRevision: 2, plan: { status: "running" } });
  });

  it("refuses a call from a turn that ended before acceptance", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    turn.end();
    expect(errorCode(await call(service, turn, "plans.create", createInput()))).toBe("turn_inactive");
    expect(memory.committed).toEqual([]);
  });

  it("does not roll back a write already started when its turn is cancelled, and settles after it", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(service, turn, "plans.create", createInput()));
    const gate = deferred();
    memory.holdCommits(gate.promise);
    const executing = service.invoke(SESSION, "plans.execute", { operationId: "op-exec", ...target(plan) }, turn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    turn.end();
    const settled = service.settleTurn(SESSION, "turn-a", "cancelled");
    gate.resolve();
    memory.holdCommits(undefined);
    expect(await executing).toMatchObject({ ok: true, plan: { revision: 2, status: "running" } });
    await settled;
    expect(service.persistedState(SESSION).plan).toMatchObject({ revision: 3, status: "paused", pauseReason: "turn_cancelled" });
  });

  it("holds the next turn until a failed settlement is persisted", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(service, turn, "plans.create", createInput()));
    okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(plan) }));
    turn.end();
    memory.force("not_committed");
    await service.settleTurn(SESSION, "turn-a", "succeeded");
    expect(service.persistedState(SESSION).plan?.status).toBe("running");
    memory.force("not_committed");
    // The committed snapshot still says running, so a read must not serve it.
    expect(await service.read(SESSION)).toEqual({ kind: "unavailable" });
    expect(await service.prepareForTurn(SESSION)).toBe(true);
    expect(await service.read(SESSION)).toMatchObject({ kind: "ok", plan: { status: "paused" } });
    expect(service.persistedState(SESSION).plan).toMatchObject({ status: "paused", pauseReason: "turn_ended" });
  });

  it("reports tools_unavailable without a writer and after the session closes", async () => {
    const turn = liveTurn("turn-a");
    expect(errorCode(await call(planService(undefined), turn, "plans.get", {}))).toBe("tools_unavailable");
    const service = planService(memoryPlanWriter().writer);
    await service.closeSession(SESSION);
    expect(errorCode(await call(service, turn, "plans.create", createInput()))).toBe("tools_unavailable");
  });
});

/** A real session store over a temp directory with injectable file faults. */
async function storeFixture(stateDir?: string) {
  const dir = stateDir ?? join(await mkdtemp(join(tmpdir(), "agentroom-plan-store-")), ".state");
  const faults: {
    writeFile?: (path: string, data: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>;
    readFile?: (path: string) => Promise<string>;
  } = {};
  const fileSystem: DurableSessionFileSystem = {
    writeFile: (path, data) => (faults.writeFile ?? ((p: string, d: string) => writeFile(p, d)))(path, data),
    rename: (from, to) => (faults.rename ?? rename)(from, to),
    readFile: (path) => (faults.readFile ?? ((p: string) => readFile(p, "utf8")))(path)
  };
  const store = new DurableAgentSessionStore({ stateDir: dir }, { fileSystem });
  const inventory = await store.initialize();
  const content = { lastMessage: "first" };
  const service: ThreadPlanService = new ThreadPlanService({
    writer: durablePlanDocumentWriter(store, (id, plan) => documentFor(id, content.lastMessage, plan)),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    newId: sequentialIds()
  });
  for (const document of inventory.documents) service.hydrate(document.session.id, document);
  const scheduleOrdinary = () => store.schedule(SESSION, () => documentFor(SESSION, content.lastMessage, service.persistedState(SESSION)));
  const onDisk = async (): Promise<DurableAgentSessionDocument | undefined> => {
    try {
      return JSON.parse(await readFile(join(dir, "sessions", `${SESSION}.json`), "utf8"));
    } catch {
      return undefined;
    }
  };
  return { dir, store, service, faults, content, scheduleOrdinary, onDisk, inventory };
}

function documentFor(
  sessionId: string,
  lastMessage: string,
  plan: Pick<DurableAgentSessionDocument, "plan" | "planMutationReceipts">
): DurableAgentSessionDocument {
  return {
    schemaVersion: 2,
    session: {
      id: sessionId, workspaceId: "workspace-1", workspacePath: "/tmp/workspace", runnerKind: "retired_runner",
      runner: { nativeSessionId: "native-1" }, status: "idle", turnCount: 0, lastMessage,
      createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z"
    },
    turns: [],
    messages: [],
    plan: plan.plan,
    planMutationReceipts: plan.planMutationReceipts
  };
}

describe("plan commits through the durable session store", () => {
  it("survives a restart, preserving the unknown runner, and replays a lost response", async () => {
    const first = await storeFixture();
    await first.scheduleOrdinary();
    const input = createInput("op-lost");
    okPlan(await call(first.service, liveTurn("turn-a"), "plans.create", input));

    const second = await storeFixture(first.dir);
    expect(second.inventory.documents[0]).toMatchObject({ session: { runnerKind: "retired_runner" }, plan: { id: "plan-1", revision: 1 } });
    const replay = await call(second.service, liveTurn("turn-b"), "plans.create", input);
    expect(replay).toMatchObject({ ok: true, replayed: true, appliedPlanId: "plan-1", appliedRevision: 1 });
  });

  it("keeps a candidate that failed before its rename out of every later ordinary write", async () => {
    const fixture = await storeFixture();
    await fixture.scheduleOrdinary();
    fixture.faults.writeFile = async () => { throw new Error("disk full"); };
    expect(errorCode(await call(fixture.service, liveTurn("turn-a"), "plans.create", createInput()))).toBe("persistence_failed");
    fixture.faults.writeFile = undefined;
    fixture.content.lastMessage = "second";
    await fixture.scheduleOrdinary();
    expect(await fixture.onDisk()).toMatchObject({ plan: null, planMutationReceipts: [], session: { lastMessage: "second" } });
  });

  it("reads back an ambiguous rename: committed when the file holds the receipt, not when it does not", async () => {
    const fixture = await storeFixture();
    await fixture.scheduleOrdinary();
    fixture.faults.rename = async (from, to) => { await rename(from, to); throw new Error("EIO after rename"); };
    const plan = okPlan(await call(fixture.service, liveTurn("turn-a"), "plans.create", createInput()));
    expect((await fixture.onDisk())?.plan?.id).toBe(plan.id);

    fixture.faults.rename = async () => { throw new Error("EIO before rename"); };
    const failed = await call(fixture.service, liveTurn("turn-a"), "plans.execute", { operationId: nextOperationId(), ...target(plan) });
    expect(errorCode(failed)).toBe("persistence_failed");
    expect((await fixture.onDisk())?.plan?.status).toBe("draft");
  });

  it("stalls ordinary writes while a commit outcome is unknown, then reconciles", async () => {
    const fixture = await storeFixture();
    await fixture.scheduleOrdinary();
    fixture.faults.rename = async (from, to) => { await rename(from, to); throw new Error("EIO after rename"); };
    fixture.faults.readFile = async () => { throw new Error("EIO on read"); };
    const op = createInput("op-ambiguous");
    expect(errorCode(await call(fixture.service, liveTurn("turn-a"), "plans.create", op))).toBe("outcome_unknown");
    expect(fixture.store.hasUnresolvedCommit(SESSION)).toBe(true);
    const before = await readFile(join(fixture.dir, "sessions", `${SESSION}.json`), "utf8");
    fixture.content.lastMessage = "must wait";
    await fixture.scheduleOrdinary();
    expect(await readFile(join(fixture.dir, "sessions", `${SESSION}.json`), "utf8")).toBe(before);
    expect(await fixture.service.read(SESSION)).toEqual({ kind: "unavailable" });

    fixture.faults.rename = undefined;
    fixture.faults.readFile = undefined;
    const replay = await call(fixture.service, liveTurn("turn-a"), "plans.create", op);
    expect(replay).toMatchObject({ ok: true, replayed: true, appliedPlanId: "plan-1" });
    await fixture.store.flush();
    expect(await fixture.onDisk()).toMatchObject({ plan: { id: "plan-1" }, session: { lastMessage: "must wait" } });
  });

  it("orders an ordinary write racing a commit so the committed plan and newest content both land", async () => {
    const fixture = await storeFixture();
    const gate = deferred();
    fixture.faults.writeFile = async (path, data) => { await gate.promise; await writeFile(path, data); };
    const ordinary = fixture.scheduleOrdinary();
    const committing = call(fixture.service, liveTurn("turn-a"), "plans.create", createInput());
    fixture.content.lastMessage = "latest";
    const followUp = fixture.scheduleOrdinary();
    gate.resolve();
    await Promise.all([ordinary, committing, followUp]);
    await fixture.store.flush();
    expect(await fixture.onDisk()).toMatchObject({ plan: { id: "plan-1" }, session: { lastMessage: "latest" } });
  });

  it("withdraws a commit whose turn ended while it waited behind an earlier write", async () => {
    const fixture = await storeFixture();
    await fixture.scheduleOrdinary();
    const gate = deferred();
    fixture.faults.writeFile = async (path, data) => { await gate.promise; await writeFile(path, data); };
    const ordinary = fixture.scheduleOrdinary();
    const turn = liveTurn("turn-a");
    const creating = call(fixture.service, turn, "plans.create", createInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    turn.end();
    gate.resolve();
    fixture.faults.writeFile = undefined;
    expect(errorCode(await creating)).toBe("turn_inactive");
    await ordinary;
    await fixture.store.flush();
    expect((await fixture.onDisk())?.plan).toBeNull();
    expect(fixture.service.persistedState(SESSION).plan).toBeNull();
  });

  it("waits out a commit in flight on deletion and never resurrects the document", async () => {
    const fixture = await storeFixture();
    await fixture.scheduleOrdinary();
    const gate = deferred();
    fixture.faults.writeFile = async (path, data) => { await gate.promise; await writeFile(path, data); };
    const committing = fixture.service.invoke(SESSION, "plans.create", createInput(), liveTurn("turn-a"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = fixture.service.closeSession(SESSION);
    const removing = fixture.store.remove(SESSION);
    gate.resolve();
    await Promise.all([committing, closing, removing]);
    expect(await readdir(join(fixture.dir, "sessions"))).toEqual([]);
    expect(await fixture.store.commit(SESSION, {
      snapshot: () => documentFor(SESSION, "x", { plan: null, planMutationReceipts: [] }),
      verify: () => true,
      settle: () => undefined
    })).toBe("removed");
    await fixture.scheduleOrdinary();
    expect(await readdir(join(fixture.dir, "sessions"))).toEqual([]);
  });

  it("pauses a running plan at hydration and persists that before the next turn", async () => {
    const first = await storeFixture();
    await first.scheduleOrdinary();
    const turn = liveTurn("turn-a");
    const plan = okPlan(await call(first.service, turn, "plans.create", createInput()));
    okPlan(await call(first.service, turn, "plans.execute", { operationId: nextOperationId(), ...target(plan) }));

    const second = await storeFixture(first.dir);
    expect(await second.service.prepareForTurn(SESSION)).toBe(true);
    expect(await second.onDisk()).toMatchObject({
      plan: { revision: 3, status: "paused", pauseReason: "backend_restarted", executionTurnId: null, lastModifiedTurnId: "turn-a" }
    });
    const resumed = okPlan(await call(second.service, liveTurn("turn-b"), "plans.execute", {
      operationId: nextOperationId(), planId: plan.id, expectedRevision: 3, resumeNote: "Backend restarted; step 1 rechecked"
    }));
    expect(resumed).toMatchObject({ status: "running", executionTurnId: "turn-b", revision: 4 });
  });
});
