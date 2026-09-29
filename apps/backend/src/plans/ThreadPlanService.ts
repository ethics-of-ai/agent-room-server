import { randomUUID } from "node:crypto";
import type { ZodError } from "zod";
import type { DurableAgentSessionDocument } from "../domain/models";
import type { DurableAgentSessionStore, DurableCommitOutcome } from "../state/DurableAgentSessionStore";
import {
  EMPTY_PLAN_STATE,
  PLAN_LIMITS,
  allStepsResolved,
  serializedBytes,
  type PlanMutationToolId,
  type PlanPersistedState,
  type ThreadPlan
} from "./planModel";
import { appendPlanReceipt, matchPlanReceipt, planArgumentsHash } from "./planReceipts";
import {
  PLAN_REREAD_GUIDANCE,
  PLAN_RESULT_SCHEMA_VERSION,
  planFailure,
  planToolInputSchemas,
  type PlanMutationInput,
  type PlanToolId,
  type PlanToolResult
} from "./planToolContract";
import { applyPlanMutation, recoverPlanAfterRestart, settlePlanAfterTurn } from "./planTransitions";

/**
 * The owner of every thread's plan: validation, receipts, revision checks,
 * the serialized mutation path, acknowledged persistence, and the system
 * transitions at turn end and restart. Tool handlers and routes call this
 * interface; nothing else changes a plan.
 *
 * Per session, work runs one operation at a time. A mutation is checked for
 * liveness and input, then against receipts, then against the expected plan
 * and revision; its candidate is written through the session store's own
 * chain, and only a confirmed write publishes the new committed state. A
 * system transition that could not be persisted is retried before any later
 * operation, so nothing is accepted on top of unrecorded recovery.
 */

/** The binding identity of the turn making a call. */
export interface PlanCallTurn {
  readonly turnId: string;
  isLive(): boolean;
  readonly signal?: AbortSignal;
}

/** The acknowledged writer the service commits through. */
export interface PlanDocumentWriter {
  commit(
    sessionId: string,
    candidate: PlanPersistedState,
    request: { verify(state: PlanPersistedState): boolean; settle(committed: boolean): void; proceed?(): boolean }
  ): Promise<DurableCommitOutcome>;
  hasUnresolvedCommit(sessionId: string): boolean;
  reconcile(sessionId: string): Promise<boolean>;
}

/** Adapt the durable session store: each commit writes the whole session document. */
export function durablePlanDocumentWriter(
  store: Pick<DurableAgentSessionStore, "commit" | "hasUnresolvedCommit" | "reconcile">,
  documentFor: (sessionId: string, planState: PlanPersistedState) => DurableAgentSessionDocument
): PlanDocumentWriter {
  return {
    commit: (sessionId, candidate, request) =>
      store.commit(sessionId, {
        snapshot: () => documentFor(sessionId, candidate),
        verify: (document) => request.verify(document),
        settle: request.settle,
        ...(request.proceed ? { proceed: request.proceed } : {})
      }),
    hasUnresolvedCommit: (sessionId) => store.hasUnresolvedCommit(sessionId),
    reconcile: (sessionId) => store.reconcile(sessionId)
  };
}

export type PlanTurnOutcome = "succeeded" | "failed" | "cancelled";

type PendingSystem = { kind: "restart" } | { kind: "turn_end"; outcome: PlanTurnOutcome; turnId: string };

interface SessionPlanRecord {
  committed: PlanPersistedState;
  pendingSystem?: PendingSystem;
  tail: Promise<unknown>;
}

export type PlanReadResult = { kind: "ok"; plan: ThreadPlan | null } | { kind: "unavailable" };

const THREAD_CLOSED_MESSAGE = "This thread is no longer available.";
const TURN_ENDED_MESSAGE = "This turn has ended; the call was not applied.";

const TURN_END_REASON = { succeeded: "turn_ended", failed: "turn_failed", cancelled: "turn_cancelled" } as const;

export class ThreadPlanService {
  private readonly records = new Map<string, SessionPlanRecord>();
  private readonly closedSessionIds = new Set<string>();
  private readonly now: () => Date;
  private readonly newId: (kind: "plan" | "step") => string;

  constructor(
    private readonly deps: {
      /** Absent: no acknowledged storage, so every call reports tools_unavailable. */
      writer?: PlanDocumentWriter;
      /** Metadata-only notification after a committed change. */
      onChanged?: (change: { sessionId: string; planId: string; revision: number }) => void;
      now?: () => Date;
      newId?: (kind: "plan" | "step") => string;
    } = {}
  ) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  /** Whether acknowledged storage exists. Without it every call reports tools_unavailable, so none is advertised. */
  get storageAvailable(): boolean {
    return this.deps.writer !== undefined;
  }

  /** Load a document's committed plan state; a running plan is recovered before any other work. */
  hydrate(sessionId: string, state: PlanPersistedState): void {
    const record = this.record(sessionId);
    record.committed = { plan: state.plan, planMutationReceipts: [...state.planMutationReceipts] };
    if (state.plan && recoverPlanAfterRestart(state.plan, this.timestamp())) {
      record.pendingSystem = { kind: "restart" };
      void this.enqueue(sessionId, (current) => this.unsettled(sessionId, current));
    }
  }

  /** The committed plan fields for an ordinary document write. */
  persistedState(sessionId: string): PlanPersistedState {
    return this.records.get(sessionId)?.committed ?? { ...EMPTY_PLAN_STATE, planMutationReceipts: [] };
  }

  /**
   * The single handler behind all six plan tools. Resolves with an envelope;
   * rejects only when a transition breaks a plan invariant, which the
   * dispatcher contains.
   */
  invoke(sessionId: string, toolId: PlanToolId, rawInput: unknown, turn: PlanCallTurn): Promise<PlanToolResult> {
    const parsed = this.parse(toolId, rawInput);
    const available = this.deps.writer !== undefined && !this.closedSessionIds.has(sessionId);
    if ("error" in parsed) {
      if (!available || !this.records.has(sessionId)) return Promise.resolve(parsed.error);
      // Name the current plan when the committed snapshot is authoritative, so
      // the model can reread it instead of guessing which plan it addressed.
      return this.enqueue(sessionId, async (record) =>
        (await this.unsettled(sessionId, record))
          ? parsed.error
          : planFailure(parsed.error.error.code, parsed.error.error.message, record.committed.plan)
      );
    }
    if (!available) {
      return Promise.resolve(planFailure("tools_unavailable", "Plan storage is unavailable in this session. Do not claim a plan was saved.", null));
    }
    return this.enqueue(sessionId, async (record) => {
      const blocked = await this.admission(sessionId, record, turn);
      if (blocked) return blocked;
      if (toolId === "plans.get") return this.success(record.committed.plan);
      return this.mutate(sessionId, record, toolId, parsed.input as PlanMutationInput, turn);
    });
  }

  /** Pause a running plan (or release a blocked plan's turn) when its turn ends. */
  settleTurn(sessionId: string, turnId: string, outcome: PlanTurnOutcome): Promise<void> {
    // No record means no plan call ever reached this session. A record
    // without a committed plan may still have a creation in flight ahead of
    // this settlement in the queue, so it settles too.
    const record = this.records.get(sessionId);
    if (this.closedSessionIds.has(sessionId) || !record) return Promise.resolve();
    // Restart recovery outranks a hydrated turn's failure: its reason is
    // backend_restarted even though the interrupted turn settles as failed.
    if (record.pendingSystem?.kind !== "restart") record.pendingSystem = { kind: "turn_end", outcome, turnId };
    return this.enqueue(sessionId, (current) => this.unsettled(sessionId, current)).then(() => undefined);
  }

  /**
   * Wait for pending plan work before a new turn is accepted. False means a
   * system transition or an ambiguous commit is still unrecorded.
   */
  async prepareForTurn(sessionId: string): Promise<boolean> {
    if (!this.records.has(sessionId)) return true;
    return this.enqueue(sessionId, async (record) => !(await this.unsettled(sessionId, record)));
  }

  /**
   * The authoritative plan for a read route, or unavailable while anything is
   * unrecorded: an ambiguous commit, or a system transition (restart recovery,
   * turn-end pause) that could not be persisted. The committed snapshot is not
   * authoritative then, because it may still say running.
   */
  read(sessionId: string): Promise<PlanReadResult> {
    if (!this.records.has(sessionId)) return Promise.resolve({ kind: "ok", plan: null });
    return this.enqueue(sessionId, async (record): Promise<PlanReadResult> =>
      (await this.unsettled(sessionId, record)) ? { kind: "unavailable" } : { kind: "ok", plan: record.committed.plan }
    );
  }

  /** Refuse further work for a deleted session and wait out what is in flight. */
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessionIds.add(sessionId);
    const record = this.records.get(sessionId);
    if (record) await record.tail.catch(() => undefined);
    this.records.delete(sessionId);
  }

  private record(sessionId: string): SessionPlanRecord {
    let record = this.records.get(sessionId);
    if (!record) {
      record = { committed: { plan: null, planMutationReceipts: [] }, tail: Promise.resolve() };
      this.records.set(sessionId, record);
    }
    return record;
  }

  private enqueue<T>(sessionId: string, work: (record: SessionPlanRecord) => Promise<T>): Promise<T> {
    const record = this.record(sessionId);
    const run = record.tail.then(() => work(record));
    record.tail = run.catch(() => undefined);
    return run;
  }

  private parse(toolId: PlanToolId, rawInput: unknown): { input: unknown } | { error: ReturnType<typeof planFailure> } {
    let bytes: number;
    try {
      bytes = serializedBytes(rawInput ?? null);
    } catch {
      return { error: planFailure("invalid_input", "Arguments must be a JSON object.", null) };
    }
    if (bytes > PLAN_LIMITS.mutationInputBytes) {
      return { error: planFailure("limit_exceeded", `Arguments are ${bytes} bytes; the limit is ${PLAN_LIMITS.mutationInputBytes}.`, null) };
    }
    const result = planToolInputSchemas[toolId].safeParse(rawInput);
    if (result.success) return { input: result.data };
    return { error: planFailure(inputErrorCode(result.error), inputErrorMessage(result.error), null) };
  }

  /** Storage, recovery, and liveness gates every call passes before touching state. */
  private async admission(sessionId: string, record: SessionPlanRecord, turn: PlanCallTurn): Promise<PlanToolResult | undefined> {
    if (this.closedSessionIds.has(sessionId)) {
      return planFailure("tools_unavailable", THREAD_CLOSED_MESSAGE, null);
    }
    if (await this.unsettled(sessionId, record)) {
      return this.deps.writer?.hasUnresolvedCommit(sessionId)
        ? planFailure("outcome_unknown", `A previous plan change may or may not have been saved. Retry later with the original operationId, or call get_plan.`, null)
        : planFailure("persistence_failed", "Plan state could not be saved. Nothing new was applied; retry later.", record.committed.plan);
    }
    if (!turn.isLive() || turn.signal?.aborted) {
      return planFailure("turn_inactive", TURN_ENDED_MESSAGE, record.committed.plan);
    }
    return undefined;
  }

  /**
   * Settle anything unrecorded before new work: reconcile an ambiguous commit,
   * then persist a pending system transition. True while either remains.
   */
  private async unsettled(sessionId: string, record: SessionPlanRecord): Promise<boolean> {
    const writer = this.deps.writer;
    if (!writer) return false;
    if (writer.hasUnresolvedCommit(sessionId) && !(await writer.reconcile(sessionId))) return true;
    const pending = record.pendingSystem;
    if (!pending) return false;
    const plan = record.committed.plan;
    const next = !plan
      ? undefined
      : pending.kind === "restart"
        ? recoverPlanAfterRestart(plan, this.timestamp())
        : settlePlanAfterTurn(plan, TURN_END_REASON[pending.outcome], pending.turnId, this.timestamp());
    if (!next) {
      record.pendingSystem = undefined;
      return false;
    }
    const outcome = await this.commit(sessionId, record, { plan: next, planMutationReceipts: record.committed.planMutationReceipts });
    if (outcome === "committed") {
      record.pendingSystem = undefined;
      return false;
    }
    return true;
  }

  private async mutate(
    sessionId: string,
    record: SessionPlanRecord,
    toolId: PlanMutationToolId,
    input: PlanMutationInput,
    turn: PlanCallTurn
  ): Promise<PlanToolResult> {
    const current = record.committed.plan;
    const argumentsHash = planArgumentsHash(input);
    const match = matchPlanReceipt(record.committed.planMutationReceipts, input.operationId, toolId, argumentsHash);
    if (match.kind === "replay") {
      return this.success(current, {
        operationId: input.operationId,
        appliedPlanId: match.receipt.planId,
        appliedRevision: match.receipt.revision,
        replayed: true
      });
    }
    if (match.kind === "conflict") {
      return planFailure("operation_conflict", `operationId ${input.operationId} was already used for a different change. Use a new operationId for new work.`, current);
    }

    const transition = applyPlanMutation(current, toolId, input, {
      turnId: turn.turnId,
      now: this.timestamp(),
      newId: this.newId
    });
    if (!transition.ok) return planFailure(transition.code, transition.message, current);

    const candidate: PlanPersistedState = {
      plan: transition.plan,
      planMutationReceipts: appendPlanReceipt(record.committed.planMutationReceipts, {
        operationId: input.operationId,
        toolId,
        argumentsHash,
        planId: transition.plan.id,
        revision: transition.plan.revision,
        turnId: turn.turnId
      })
    };
    // The writer asks `proceed` immediately before the write starts, after any
    // write queued ahead of it. That is the last point a cancellation refuses
    // the call; once the write starts it is not rolled back, and the
    // dispatcher discards a late result.
    const outcome = await this.commit(sessionId, record, candidate, () => turn.isLive() && !turn.signal?.aborted);
    switch (outcome) {
      case "committed":
        return this.success(transition.plan, {
          operationId: input.operationId,
          appliedPlanId: transition.plan.id,
          appliedRevision: transition.plan.revision,
          replayed: false
        });
      case "not_committed":
        return planFailure("persistence_failed", "The plan change could not be saved and was not applied. Retry with the same operationId.", current);
      case "unknown":
        return planFailure("outcome_unknown", `The plan change may or may not have been saved. Retry with the same operationId once storage recovers. ${PLAN_REREAD_GUIDANCE}`, null);
      case "removed":
        return planFailure("tools_unavailable", THREAD_CLOSED_MESSAGE, null);
      case "withdrawn":
        return planFailure("turn_inactive", TURN_ENDED_MESSAGE, current);
    }
  }

  private async commit(
    sessionId: string,
    record: SessionPlanRecord,
    candidate: PlanPersistedState,
    proceed?: () => boolean
  ): Promise<DurableCommitOutcome> {
    const plan = candidate.plan;
    const receipt = candidate.planMutationReceipts.at(-1);
    return (this.deps.writer as PlanDocumentWriter).commit(sessionId, candidate, {
      ...(proceed ? { proceed } : {}),
      verify: (state) =>
        state.plan?.id === plan?.id &&
        state.plan?.revision === plan?.revision &&
        (receipt === undefined || state.planMutationReceipts.some((entry) => entry.operationId === receipt.operationId && entry.argumentsHash === receipt.argumentsHash)),
      settle: (committed) => {
        if (!committed || this.closedSessionIds.has(sessionId)) return;
        record.committed = candidate;
        if (plan) this.deps.onChanged?.({ sessionId, planId: plan.id, revision: plan.revision });
      }
    });
  }

  private success(
    plan: ThreadPlan | null,
    mutation?: { operationId: string; appliedPlanId: string; appliedRevision: number; replayed: boolean }
  ): PlanToolResult {
    return {
      schemaVersion: PLAN_RESULT_SCHEMA_VERSION,
      ok: true,
      plan,
      ...mutation,
      ...(plan?.status === "running" && allStepsResolved(plan) ? { readyToFinish: true as const } : {})
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function inputErrorCode(error: ZodError): "limit_exceeded" | "invalid_input" {
  return error.issues.some((issue) => issue.code === "too_big") ? "limit_exceeded" : "invalid_input";
}

function inputErrorMessage(error: ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `Invalid arguments. ${path}${issue?.message ?? "invalid"}`.slice(0, 512);
}
