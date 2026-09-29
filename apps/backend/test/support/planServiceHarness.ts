import type { PlanPersistedState } from "../../src/plans/planModel";
import { planToolResultSchema, type PlanToolId, type PlanToolResult } from "../../src/plans/planToolContract";
import { ThreadPlanService, type PlanCallTurn, type PlanDocumentWriter } from "../../src/plans/ThreadPlanService";
import type { DurableCommitOutcome } from "../../src/state/DurableAgentSessionStore";

/**
 * An acknowledged writer fake for plan service tests: records committed
 * candidates, can force an outcome per commit, and can hold a commit open on
 * a caller-controlled promise.
 */
export function memoryPlanWriter() {
  const committed: PlanPersistedState[] = [];
  const forced: DurableCommitOutcome[] = [];
  let hold: Promise<void> | undefined;
  let unresolved: { candidate: PlanPersistedState; settle(committed: boolean): void } | undefined;
  let reconcileAs: boolean | undefined;
  const writer: PlanDocumentWriter = {
    async commit(_sessionId, candidate, request) {
      // The store asks `proceed` as the write starts; a held commit models a
      // write already in flight, so the question comes before the hold.
      if (request.proceed && !request.proceed()) {
        request.settle(false);
        return "withdrawn";
      }
      const gate = hold;
      await gate;
      const outcome = forced.shift() ?? "committed";
      if (outcome === "committed") {
        committed.push(candidate);
        request.settle(true);
      } else if (outcome === "not_committed") {
        request.settle(false);
      } else if (outcome === "unknown") {
        unresolved = { candidate, settle: request.settle };
      }
      return outcome;
    },
    hasUnresolvedCommit: () => unresolved !== undefined,
    async reconcile() {
      if (!unresolved || reconcileAs === undefined) return !unresolved;
      if (reconcileAs) committed.push(unresolved.candidate);
      unresolved.settle(reconcileAs);
      unresolved = undefined;
      return true;
    }
  };
  return {
    writer,
    committed,
    force: (...outcomes: DurableCommitOutcome[]) => forced.push(...outcomes),
    holdCommits: (gate: Promise<void> | undefined) => { hold = gate; },
    /** Decide what a later reconcile finds; undefined keeps it unknown. */
    reconcileAs: (value: boolean | undefined) => { reconcileAs = value; }
  };
}

export function sequentialIds(): (kind: "plan" | "step") => string {
  const counters = { plan: 0, step: 0 };
  return (kind) => `${kind}-${++counters[kind]}`;
}

export function planService(writer?: PlanDocumentWriter, changes: unknown[] = []) {
  return new ThreadPlanService({
    ...(writer ? { writer } : {}),
    onChanged: (change) => changes.push(change),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    newId: sequentialIds()
  });
}

export function liveTurn(turnId: string): PlanCallTurn & { end(): void } {
  let live = true;
  return { turnId, isLive: () => live, end: () => { live = false; } };
}

let operation = 0;
export const nextOperationId = (): string => `op-${++operation}`;

/** Invoke and hold the envelope to its own schema and byte bound. */
export async function call(
  service: ThreadPlanService,
  turn: PlanCallTurn,
  toolId: PlanToolId,
  input: Record<string, unknown>,
  sessionId = "agent-session-1"
): Promise<PlanToolResult> {
  const result = await service.invoke(sessionId, toolId, input, turn);
  const parsed = planToolResultSchema.parse(JSON.parse(JSON.stringify(result)));
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 40 * 1024) throw new Error("result exceeds 40 KiB");
  return parsed;
}

export function okPlan(result: PlanToolResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  if (!result.plan) throw new Error("expected a plan");
  return result.plan;
}

export function errorCode(result: PlanToolResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}
