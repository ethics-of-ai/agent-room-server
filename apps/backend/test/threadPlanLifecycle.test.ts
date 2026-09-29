import { describe, expect, it } from "vitest";
import {
  call,
  errorCode,
  liveTurn,
  memoryPlanWriter,
  nextOperationId,
  okPlan,
  planService
} from "./support/planServiceHarness";
import { PLAN_LIMITS, planMutationReceiptSchema, serializedBytes, type ThreadPlan } from "../src/plans/planModel";

const target = (plan: ThreadPlan) => ({ planId: plan.id, expectedRevision: plan.revision });

async function createTwoStep(service: ReturnType<typeof planService>, turn = liveTurn("turn-a")) {
  const result = await call(service, turn, "plans.create", {
    operationId: nextOperationId(),
    objective: "Ship the feature",
    completionCriteria: "Tests pass",
    steps: [{ description: "Write code" }, { description: "Write tests" }]
  });
  return { result, plan: okPlan(result), turn };
}

describe("thread plan reference lifecycle", () => {
  it("runs the contract's reference table across three turns", async () => {
    const memory = memoryPlanWriter();
    const changes: unknown[] = [];
    const service = planService(memory.writer, changes);
    const turnA = liveTurn("turn-a");

    const createOperation = nextOperationId();
    const createInput = {
      operationId: createOperation,
      objective: "Ship the feature",
      completionCriteria: "Tests pass",
      steps: [{ description: "Write code" }, { description: "Write tests" }]
    };
    let plan = okPlan(await call(service, turnA, "plans.create", createInput));
    expect(plan).toMatchObject({ id: "plan-1", revision: 1, status: "draft" });
    expect(plan.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
    const [first, second] = plan.steps.map((step) => step.id);

    plan = okPlan(await call(service, turnA, "plans.edit", {
      operationId: nextOperationId(), ...target(plan), objective: plan.objective, completionCriteria: plan.completionCriteria,
      steps: [{ id: first, description: "Write code" }, { id: second, description: "Write thorough tests" }]
    }));
    expect(plan).toMatchObject({ revision: 2, status: "draft" });
    expect(plan.steps.map((step) => step.id)).toEqual([first, second]);

    plan = okPlan(await call(service, turnA, "plans.execute", { operationId: nextOperationId(), ...target(plan) }));
    expect(plan).toMatchObject({ revision: 3, status: "running", executionTurnId: "turn-a" });
    expect(plan.steps[0]!.status).toBe("in_progress");

    plan = okPlan(await call(service, turnA, "plans.update_step", {
      operationId: nextOperationId(), ...target(plan), stepId: first, status: "completed", note: "Code written"
    }));
    expect(plan.revision).toBe(4);
    expect(plan.steps.map((step) => step.status)).toEqual(["completed", "pending"]);

    plan = okPlan(await call(service, turnA, "plans.update_step", { operationId: nextOperationId(), ...target(plan), stepId: second, status: "in_progress" }));
    expect(plan.revision).toBe(5);

    plan = okPlan(await call(service, turnA, "plans.update_step", {
      operationId: nextOperationId(), ...target(plan), stepId: second, status: "blocked", note: "Fixture missing"
    }));
    expect(plan).toMatchObject({ revision: 6, status: "blocked" });

    turnA.end();
    await service.settleTurn("agent-session-1", "turn-a", "succeeded");
    const turnB = liveTurn("turn-b");
    plan = okPlan(await call(service, turnB, "plans.get", {}));
    expect(plan).toMatchObject({ revision: 7, status: "blocked", executionTurnId: null });

    plan = okPlan(await call(service, turnB, "plans.execute", {
      operationId: nextOperationId(), ...target(plan), resumeNote: "Fixture restored; retrying"
    }));
    expect(plan).toMatchObject({ revision: 8, status: "running", resumeNote: "Fixture restored; retrying" });
    expect(plan.steps[1]).toMatchObject({ status: "in_progress", lastBlocker: "Fixture missing" });

    const ready = await call(service, turnB, "plans.update_step", {
      operationId: nextOperationId(), ...target(plan), stepId: second, status: "completed", note: "Tests pass"
    });
    plan = okPlan(ready);
    expect(plan.revision).toBe(9);
    expect(ready.ok && ready.readyToFinish).toBe(true);

    plan = okPlan(await call(service, turnB, "plans.finish", {
      operationId: nextOperationId(), ...target(plan), outcome: "completed", summary: "Feature shipped; tests pass"
    }));
    expect(plan).toMatchObject({ revision: 10, status: "completed", executionTurnId: null });
    turnB.end();
    await service.settleTurn("agent-session-1", "turn-b", "succeeded");

    const turnC = liveTurn("turn-c");
    const p1 = plan;
    const replaced = okPlan(await call(service, turnC, "plans.create", {
      operationId: nextOperationId(), objective: "Next", completionCriteria: "Done", steps: [{ description: "One" }],
      replace: true, ...target(p1)
    }));
    expect(replaced).toMatchObject({ id: "plan-2", revision: 1, status: "draft" });
    expect(replaced.steps[0]!.id).not.toBe(first);

    const replay = await call(service, turnC, "plans.create", createInput);
    expect(replay).toMatchObject({ ok: true, replayed: true, appliedPlanId: "plan-1", appliedRevision: 1, plan: { id: "plan-2", revision: 1 } });

    const stale = await call(service, turnC, "plans.update_step", {
      operationId: nextOperationId(), planId: p1.id, expectedRevision: p1.revision, stepId: first, status: "in_progress"
    });
    expect(errorCode(stale)).toBe("plan_conflict");
    expect(okPlan(await call(service, turnC, "plans.get", {}))).toEqual(replaced);
    expect(changes).toHaveLength(11);
    expect(changes[0]).toEqual({ sessionId: "agent-session-1", planId: "plan-1", revision: 1 });
  });

  it("executes several steps in one turn and never starts work on create or edit", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: created, turn } = await createTwoStep(service);
    expect(created.executionTurnId).toBeNull();
    let plan = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(created) }));
    for (const step of plan.steps) {
      if (plan.steps.find((entry) => entry.id === step.id)!.status === "pending") {
        plan = okPlan(await call(service, turn, "plans.update_step", { operationId: nextOperationId(), ...target(plan), stepId: step.id, status: "in_progress" }));
      }
      plan = okPlan(await call(service, turn, "plans.update_step", { operationId: nextOperationId(), ...target(plan), stepId: step.id, status: "completed", note: "done" }));
    }
    expect(plan.steps.every((step) => step.status === "completed")).toBe(true);
    expect(plan.status).toBe("running");
  });
});

describe("thread plan transitions", () => {
  it("refuses creation over an existing plan and replacement of an absent one", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const replaceAbsent = await call(service, turn, "plans.create", {
      operationId: nextOperationId(), objective: "x", completionCriteria: "y", steps: [{ description: "z" }],
      replace: true, planId: "plan-9", expectedRevision: 1
    });
    expect(errorCode(replaceAbsent)).toBe("plan_conflict");
    await createTwoStep(service, turn);
    const again = await call(service, turn, "plans.create", {
      operationId: nextOperationId(), objective: "x", completionCriteria: "y", steps: [{ description: "z" }]
    });
    expect(errorCode(again)).toBe("plan_conflict");
  });

  it("reports plan_not_found and stale targets", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const missing = await call(service, turn, "plans.execute", { operationId: nextOperationId(), planId: "plan-1", expectedRevision: 1 });
    expect(errorCode(missing)).toBe("plan_not_found");
    expect(await call(service, turn, "plans.get", {})).toEqual({ schemaVersion: 1, ok: true, plan: null });
    const { plan } = await createTwoStep(service, turn);
    const staleRevision = await call(service, turn, "plans.execute", { operationId: nextOperationId(), planId: plan.id, expectedRevision: 2 });
    expect(staleRevision).toMatchObject({ ok: false, error: { code: "plan_conflict", planId: plan.id, revision: 1 }, plan: { id: plan.id } });
    const wrongPlan = await call(service, turn, "plans.execute", { operationId: nextOperationId(), planId: "plan-9", expectedRevision: 1 });
    expect(errorCode(wrongPlan)).toBe("plan_conflict");
  });

  it("keeps started work first and refuses no-op, duplicate, and foreign edits", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: created, turn } = await createTwoStep(service);
    const [first, second] = created.steps.map((step) => step.id);
    const running = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(created) }));
    const edit = (steps: unknown[], plan = running) => call(service, turn, "plans.edit", {
      operationId: nextOperationId(), ...target(plan), objective: plan.objective, completionCriteria: plan.completionCriteria, steps
    });

    expect(errorCode(await edit([{ id: first, description: "Write code" }, { id: second, description: "Write tests" }]))).toBe("invalid_transition");
    expect(errorCode(await edit([{ id: second, description: "Write tests" }, { id: first, description: "Write code" }]))).toBe("invalid_transition");
    expect(errorCode(await edit([{ id: first, description: "Rewritten" }, { id: second, description: "Write tests" }]))).toBe("invalid_transition");
    expect(errorCode(await edit([{ id: first, description: "Write code" }, { id: first, description: "again" }]))).toBe("invalid_input");
    expect(errorCode(await edit([{ id: first, description: "Write code" }, { id: "step-99", description: "foreign" }]))).toBe("invalid_transition");

    const revised = okPlan(await edit([{ id: first, description: "Write code" }, { description: "Document it" }]));
    expect(revised.steps.map((step) => step.description)).toEqual(["Write code", "Document it"]);
    expect(revised.steps[1]!.id).not.toBe(second);
    expect(revised.steps[0]!.status).toBe("in_progress");
    expect(revised.status).toBe("running");
  });

  it("enforces execute notes and refuses executing a running plan", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: created, turn } = await createTwoStep(service);
    expect(errorCode(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(created), resumeNote: "no" }))).toBe("invalid_input");
    const running = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(created) }));
    expect(errorCode(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(running) }))).toBe("invalid_transition");
    turn.end();
    await service.settleTurn("agent-session-1", "turn-a", "cancelled");
    const turnB = liveTurn("turn-b");
    const paused = okPlan(await call(service, turnB, "plans.get", {}));
    expect(paused).toMatchObject({ status: "paused", pauseReason: "turn_cancelled", executionTurnId: null });
    expect(paused.steps[0]!.status).toBe("in_progress");
    expect(errorCode(await call(service, turnB, "plans.execute", { operationId: nextOperationId(), ...target(paused) }))).toBe("invalid_input");
    const resumed = okPlan(await call(service, turnB, "plans.execute", { operationId: nextOperationId(), ...target(paused), resumeNote: "Rechecked" }));
    expect(resumed).toMatchObject({ status: "running", pauseReason: null, executionTurnId: "turn-b" });
  });

  it("changes only the current step, in allowed directions, from the execution turn", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: created, turn } = await createTwoStep(service);
    const [first, second] = created.steps.map((step) => step.id);
    const update = (plan: ThreadPlan, input: Record<string, unknown>, by = turn) =>
      call(service, by, "plans.update_step", { operationId: nextOperationId(), ...target(plan), ...input });

    expect(errorCode(await update(created, { stepId: first, status: "in_progress" }))).toBe("invalid_transition");
    const running = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(created) }));
    expect(errorCode(await update(running, { stepId: second, status: "in_progress" }))).toBe("invalid_transition");
    expect(errorCode(await update(running, { stepId: first, status: "in_progress" }))).toBe("invalid_transition");
    // An input refusal still names the current plan, so the model can reread it.
    expect(await update(running, { stepId: first, status: "completed" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", planId: running.id, revision: running.revision },
      plan: { id: running.id, revision: running.revision }
    });
    expect(errorCode(await update(running, { stepId: first, status: "completed", note: "x" }, liveTurn("turn-other")))).toBe("invalid_transition");
    const skipped = okPlan(await update(running, { stepId: first, status: "skipped", note: "Not needed" }));
    expect(skipped.steps[0]).toMatchObject({ status: "skipped", outcome: "Not needed" });
    expect(errorCode(await update(skipped, { stepId: second, status: "completed", note: "x" }))).toBe("invalid_transition");
    const started = okPlan(await update(skipped, { stepId: second, status: "in_progress", note: "Starting the second step" }));
    expect(started.steps[1]).toMatchObject({ status: "in_progress", outcome: null, lastBlocker: null });
  });

  it("finishes by completion only after execution with every step resolved, and cancels from any live state", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: draft, turn } = await createTwoStep(service);
    const finish = (plan: ThreadPlan, outcome: string) =>
      call(service, turn, "plans.finish", { operationId: nextOperationId(), ...target(plan), outcome, summary: "Summary" });
    expect(errorCode(await finish(draft, "completed"))).toBe("invalid_transition");
    const running = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(draft) }));
    expect(errorCode(await finish(running, "completed"))).toBe("invalid_transition");
    const cancelled = okPlan(await finish(running, "cancelled"));
    expect(cancelled).toMatchObject({ status: "cancelled", summary: "Summary", executionTurnId: null });
    expect(cancelled.steps[0]!.status).toBe("pending");
    for (const tool of ["plans.edit", "plans.execute", "plans.finish"] as const) {
      const result = await call(service, turn, tool, {
        operationId: nextOperationId(), ...target(cancelled),
        ...(tool === "plans.edit" ? { objective: "o", completionCriteria: "c", steps: [{ description: "d" }] } : {}),
        ...(tool === "plans.finish" ? { outcome: "cancelled", summary: "again" } : {})
      });
      expect(errorCode(result)).toBe("invalid_transition");
    }
  });

  it("completes a paused plan whose steps were all resolved before the pause", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    let plan = okPlan(await call(service, turn, "plans.create", {
      operationId: nextOperationId(), objective: "o", completionCriteria: "c", steps: [{ description: "only" }]
    }));
    plan = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(plan) }));
    plan = okPlan(await call(service, turn, "plans.update_step", { operationId: nextOperationId(), ...target(plan), stepId: plan.steps[0]!.id, status: "completed", note: "done" }));
    turn.end();
    await service.settleTurn("agent-session-1", "turn-a", "failed");
    const turnB = liveTurn("turn-b");
    plan = okPlan(await call(service, turnB, "plans.get", {}));
    expect(plan).toMatchObject({ status: "paused", pauseReason: "turn_failed" });
    const finished = okPlan(await call(service, turnB, "plans.finish", { operationId: nextOperationId(), ...target(plan), outcome: "completed", summary: "All done" }));
    expect(finished.status).toBe("completed");
  });

  it("leaves draft and terminal plans unchanged at settlement", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const { plan, turn } = await createTwoStep(service);
    turn.end();
    await service.settleTurn("agent-session-1", "turn-a", "succeeded");
    expect(memory.committed).toHaveLength(1);
    expect(okPlan(await call(service, liveTurn("turn-b"), "plans.get", {}))).toEqual(plan);
  });
});

describe("thread plan input bounds", () => {
  it("keeps the largest receipt the field bounds allow under the receipt budget", () => {
    const receipt = planMutationReceiptSchema.parse({
      operationId: "o".repeat(PLAN_LIMITS.operationIdChars),
      toolId: "plans.update_step",
      argumentsHash: "f".repeat(64),
      planId: "p".repeat(PLAN_LIMITS.idChars),
      revision: Number.MAX_SAFE_INTEGER,
      turnId: "t".repeat(PLAN_LIMITS.idChars)
    });
    expect(serializedBytes(receipt)).toBeLessThan(PLAN_LIMITS.receiptBytes);
  });

  it("rejects unknown fields, whitespace text, and malformed operation ids as invalid_input", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const base = { operationId: "op-bounds", objective: "o", completionCriteria: "c", steps: [{ description: "d" }] };
    expect(errorCode(await call(service, turn, "plans.create", { ...base, extra: true }))).toBe("invalid_input");
    expect(errorCode(await call(service, turn, "plans.create", { ...base, objective: "   " }))).toBe("invalid_input");
    expect(errorCode(await call(service, turn, "plans.create", { ...base, operationId: "bad id" }))).toBe("invalid_input");
    expect(errorCode(await call(service, turn, "plans.create", { ...base, steps: [] }))).toBe("invalid_input");
    expect(errorCode(await call(service, turn, "plans.get", { planId: "x" }))).toBe("invalid_input");
    expect(errorCode(await call(service, turn, "plans.create", { ...base, replace: false, planId: "plan-1" }))).toBe("invalid_input");
  });

  it("reports every count and text bound as limit_exceeded, counting UTF-16 code units", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const base = { operationId: "op-limits", objective: "o", completionCriteria: "c", steps: [{ description: "d" }] };
    const cases: Array<Record<string, unknown>> = [
      { objective: "x".repeat(2_049) },
      { completionCriteria: "x".repeat(4_097) },
      { steps: [{ description: "x".repeat(1_025) }] },
      { steps: Array.from({ length: 65 }, () => ({ description: "d" })) },
      { operationId: "o".repeat(129) }
    ];
    for (const override of cases) {
      expect(errorCode(await call(service, turn, "plans.create", { ...base, ...override }))).toBe("limit_exceeded");
    }
    // 1,024 emoji are 2,048 UTF-16 code units: at the objective limit, not over it.
    expect(okPlan(await call(service, turn, "plans.create", { ...base, objective: "😀".repeat(1_024) })).objective).toHaveLength(2_048);
  });

  it("keeps the last safe revision for the pause, so a running plan never outlives its turn", async () => {
    const service = planService(memoryPlanWriter().writer);
    const { plan: draft, turn } = await createTwoStep(service);
    const running = okPlan(await call(service, turn, "plans.execute", { operationId: nextOperationId(), ...target(draft) }));
    const lastMutable = Number.MAX_SAFE_INTEGER - 1;

    const refusing = planService(memoryPlanWriter().writer);
    refusing.hydrate("agent-session-1", { plan: { ...draft, revision: lastMutable }, planMutationReceipts: [] });
    const refused = await call(refusing, turn, "plans.execute", { operationId: nextOperationId(), planId: draft.id, expectedRevision: lastMutable });
    expect(errorCode(refused)).toBe("limit_exceeded");

    const settling = planService(memoryPlanWriter().writer);
    settling.hydrate("agent-session-1", { plan: { ...running, revision: lastMutable }, planMutationReceipts: [] });
    expect(await settling.prepareForTurn("agent-session-1")).toBe(true);
    expect(settling.persistedState("agent-session-1").plan).toMatchObject({
      status: "paused", pauseReason: "backend_restarted", revision: Number.MAX_SAFE_INTEGER
    });
  });

  it("refuses oversized arguments whole and a candidate plan over 31 KiB without storing it", async () => {
    const memory = memoryPlanWriter();
    const service = planService(memory.writer);
    const turn = liveTurn("turn-a");
    const big = await call(service, turn, "plans.create", {
      operationId: "op-big", objective: "o", completionCriteria: "c".repeat(4_000),
      steps: Array.from({ length: 40 }, () => ({ description: "x".repeat(1_024) }))
    });
    expect(errorCode(big)).toBe("limit_exceeded");
    const candidate = await call(service, turn, "plans.create", {
      operationId: "op-candidate", objective: "o".repeat(2_000), completionCriteria: "c".repeat(4_000),
      steps: Array.from({ length: 26 }, () => ({ description: "x".repeat(1_000) }))
    });
    expect(errorCode(candidate)).toBe("limit_exceeded");
    expect(memory.committed).toEqual([]);
  });

  it("keeps the largest stored plan's result under 40 KiB", async () => {
    const service = planService(memoryPlanWriter().writer);
    const turn = liveTurn("turn-a");
    const result = await call(service, turn, "plans.create", {
      operationId: "op-near-limit", objective: "o".repeat(2_000), completionCriteria: "c".repeat(4_000),
      steps: Array.from({ length: 23 }, () => ({ description: "x".repeat(1_000) }))
    });
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(40 * 1024);
  });
});
