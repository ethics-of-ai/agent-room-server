import {
  PLAN_LIMITS,
  RESOLVED_STEP_STATUSES,
  TERMINAL_PLAN_STATUSES,
  allStepsResolved,
  currentStepIndex,
  planInvariantIssue,
  planSizeIssue,
  type PlanMutationToolId,
  type PlanPauseReason,
  type ThreadPlan,
  type ThreadPlanStep
} from "./planModel";
import {
  PLAN_REREAD_GUIDANCE,
  type CreatePlanInput,
  type EditPlanInput,
  type ExecutePlanInput,
  type FinishPlanInput,
  type PlanErrorCode,
  type PlanMutationInput,
  type UpdatePlanStepInput
} from "./planToolContract";

/**
 * Pure plan transitions. Each takes the committed plan and a validated input
 * and returns the candidate plan or a closed refusal code; nothing here
 * persists, publishes, or checks turn liveness. Accepted mutations advance
 * the revision by one and stamp the originating turn.
 */

export interface PlanTransitionContext {
  /** The AgentRoom turn the binding serves. */
  readonly turnId: string;
  readonly now: string;
  newId(kind: "plan" | "step"): string;
}

export type PlanTransitionResult =
  | { ok: true; plan: ThreadPlan }
  | { ok: false; code: PlanErrorCode; message: string };

const refuse = (code: PlanErrorCode, message: string): PlanTransitionResult => ({ ok: false, code, message });

export function applyPlanMutation(
  current: ThreadPlan | null,
  toolId: PlanMutationToolId,
  input: PlanMutationInput,
  context: PlanTransitionContext
): PlanTransitionResult {
  const result = toolId === "plans.create"
    ? createPlan(current, input as CreatePlanInput, context)
    : mutateExisting(current, toolId, input as Exclude<PlanMutationInput, CreatePlanInput>, context);
  if (!result.ok) return result;
  const invariant = planInvariantIssue(result.plan);
  if (invariant) throw new Error(`Plan transition produced an invalid plan: ${invariant}`);
  const size = planSizeIssue(result.plan, PLAN_LIMITS.candidatePlanBytes);
  if (size) return refuse("limit_exceeded", `The resulting ${size}. Shorten the plan text.`);
  return result;
}

function createPlan(current: ThreadPlan | null, input: CreatePlanInput, context: PlanTransitionContext): PlanTransitionResult {
  if (!input.replace && current) {
    return refuse("plan_conflict", `This thread already has a plan. To replace it, pass replace: true with its planId and expectedRevision. ${PLAN_REREAD_GUIDANCE}`);
  }
  if (input.replace) {
    if (!current) return refuse("plan_conflict", `There is no plan to replace. ${PLAN_REREAD_GUIDANCE}`);
    const stale = staleTarget(current, input.planId as string, input.expectedRevision as number);
    if (stale) return stale;
  }
  return {
    ok: true,
    plan: {
      id: context.newId("plan"),
      revision: 1,
      objective: input.objective,
      completionCriteria: input.completionCriteria,
      steps: input.steps.map((step) => pendingStep(context.newId("step"), step.description)),
      status: "draft",
      createdAt: context.now,
      updatedAt: context.now,
      lastModifiedTurnId: context.turnId,
      executionTurnId: null,
      pauseReason: null,
      resumeNote: null,
      summary: null
    }
  };
}

function mutateExisting(
  current: ThreadPlan | null,
  toolId: Exclude<PlanMutationToolId, "plans.create">,
  input: Exclude<PlanMutationInput, CreatePlanInput>,
  context: PlanTransitionContext
): PlanTransitionResult {
  if (!current) return refuse("plan_not_found", "This thread has no plan. Call create_plan to make one.");
  const stale = staleTarget(current, input.planId, input.expectedRevision);
  if (stale) return stale;
  if (TERMINAL_PLAN_STATUSES.has(current.status)) {
    return refuse("invalid_transition", `The plan is ${current.status}. Only get_plan or an explicit replacement is allowed.`);
  }
  if (current.revision >= MAX_MUTATION_REVISION) {
    return refuse("limit_exceeded", "The plan revision cannot advance further. Replace the plan.");
  }
  const next = (() => {
    switch (toolId) {
      case "plans.edit": return editPlan(current, input as EditPlanInput, context);
      case "plans.execute": return executePlan(current, input as ExecutePlanInput, context);
      case "plans.update_step": return updateStep(current, input as UpdatePlanStepInput, context);
      case "plans.finish": return finishPlan(current, input as FinishPlanInput, context);
    }
  })();
  if (!next.ok) return next;
  return { ...next, plan: advance(next.plan, context.now, context.turnId) };
}

function staleTarget(current: ThreadPlan, planId: string, expectedRevision: number): PlanTransitionResult | undefined {
  if (planId !== current.id) {
    return refuse("plan_conflict", `The plan ${planId.slice(0, 128)} is not this thread's current plan. ${PLAN_REREAD_GUIDANCE}`);
  }
  if (expectedRevision !== current.revision) {
    return refuse("plan_conflict", `The plan is at revision ${current.revision}, not ${expectedRevision}. ${PLAN_REREAD_GUIDANCE}`);
  }
  return undefined;
}

function editPlan(current: ThreadPlan, input: EditPlanInput, context: PlanTransitionContext): PlanTransitionResult {
  const existing = new Map(current.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  for (const step of input.steps) {
    if (step.id === undefined) continue;
    if (seen.has(step.id)) return refuse("invalid_input", `Step ${step.id} appears more than once.`);
    seen.add(step.id);
    if (!existing.has(step.id)) return refuse("invalid_transition", `Step ${step.id} is not part of this plan.`);
  }

  // The resolved prefix and the current active step are work already started
  // or finished: they must come first, unchanged and in order.
  const currentIndex = currentStepIndex(current);
  const activeStep = current.steps[currentIndex]?.status === "pending" ? undefined : current.steps[currentIndex];
  const kept = current.steps.slice(0, currentIndex + (activeStep ? 1 : 0));
  for (const [index, step] of kept.entries()) {
    const proposed = input.steps[index];
    if (proposed?.id !== step.id || proposed.description !== step.description) {
      return refuse(
        "invalid_transition",
        "Edits must keep every completed, skipped, in-progress, or blocked step first, unchanged, and in order. Replace the plan to discard started work."
      );
    }
  }
  const steps = input.steps.map((step): ThreadPlanStep => {
    const previous = step.id === undefined ? undefined : existing.get(step.id);
    if (!previous) return pendingStep(context.newId("step"), step.description);
    return { ...previous, description: step.description };
  });
  if (
    input.objective === current.objective &&
    input.completionCriteria === current.completionCriteria &&
    steps.length === current.steps.length &&
    steps.every((step, index) => step.id === current.steps[index]!.id && step.description === current.steps[index]!.description)
  ) {
    return refuse("invalid_transition", "The edit changes nothing.");
  }
  return {
    ok: true,
    plan: { ...current, objective: input.objective, completionCriteria: input.completionCriteria, steps }
  };
}

function executePlan(current: ThreadPlan, input: ExecutePlanInput, context: PlanTransitionContext): PlanTransitionResult {
  if (current.status === "running") return refuse("invalid_transition", "The plan is already running.");
  if (current.status === "draft" && input.resumeNote !== undefined) {
    return refuse("invalid_input", "A draft plan starts without a resumeNote.");
  }
  if (current.status !== "draft" && input.resumeNote === undefined) {
    return refuse("invalid_input", `Resuming a ${current.status} plan requires a resumeNote explaining your reassessment.`);
  }
  const index = currentStepIndex(current);
  const steps = current.steps.map((step, position) =>
    position === index ? { ...step, status: "in_progress" as const } : step
  );
  const plan: ThreadPlan = {
    ...current,
    steps,
    status: "running",
    executionTurnId: context.turnId,
    pauseReason: null,
    resumeNote: input.resumeNote ?? null
  };
  return { ok: true, plan };
}

function updateStep(current: ThreadPlan, input: UpdatePlanStepInput, context: PlanTransitionContext): PlanTransitionResult {
  if (current.status !== "running") {
    return refuse("invalid_transition", `Steps change only while the plan is running; it is ${current.status}. Call execute_plan first.`);
  }
  if (current.executionTurnId !== context.turnId) {
    return refuse("invalid_transition", "The plan is running under another turn. Call execute_plan in this turn.");
  }
  const index = currentStepIndex(current);
  const step = current.steps[index];
  if (!step || step.id !== input.stepId) {
    return refuse("invalid_transition", "Only the current step may change. Call get_plan to see which step is current.");
  }
  const allowed = step.status === "pending" ? ["in_progress", "skipped"] : ["completed", "blocked", "skipped"];
  if (!allowed.includes(input.status)) {
    return refuse("invalid_transition", `A ${step.status} step cannot become ${input.status}.`);
  }
  const updated: ThreadPlanStep = {
    ...step,
    status: input.status,
    ...(RESOLVED_STEP_STATUSES.has(input.status) ? { outcome: input.note ?? null } : {}),
    ...(input.status === "blocked" ? { lastBlocker: input.note ?? null } : {})
  };
  const plan: ThreadPlan = {
    ...current,
    steps: current.steps.map((entry, position) => (position === index ? updated : entry)),
    status: input.status === "blocked" ? "blocked" : "running"
  };
  return { ok: true, plan };
}

function finishPlan(current: ThreadPlan, input: FinishPlanInput, context: PlanTransitionContext): PlanTransitionResult {
  if (input.outcome === "completed") {
    if (current.status === "draft") return refuse("invalid_transition", "A plan that never ran cannot complete. Execute it first.");
    if (!allStepsResolved(current)) return refuse("invalid_transition", "Every step must be completed or skipped before the plan completes.");
    if (current.status === "running" && current.executionTurnId !== context.turnId) {
      return refuse("invalid_transition", "The plan is running under another turn. Call execute_plan in this turn.");
    }
  }
  return {
    ok: true,
    plan: {
      ...current,
      steps: current.steps.map((step) => (step.status === "in_progress" ? { ...step, status: "pending" as const } : step)),
      status: input.outcome,
      executionTurnId: null,
      pauseReason: null,
      summary: input.summary
    }
  };
}

/**
 * The settlement transition when a turn ends: a running plan pauses with the
 * turn's outcome as its reason, keeping its in-progress step for
 * reassessment; a blocked plan drops its execution turn. Returns undefined
 * when nothing changes.
 */
export function settlePlanAfterTurn(
  plan: ThreadPlan,
  reason: Exclude<PlanPauseReason, "backend_restarted">,
  turnId: string,
  now: string
): ThreadPlan | undefined {
  return systemTransition(plan, reason, turnId, now);
}

/** Hydration recovery: nothing can still be running after a restart. */
export function recoverPlanAfterRestart(plan: ThreadPlan, now: string): ThreadPlan | undefined {
  return systemTransition(plan, "backend_restarted", plan.executionTurnId, now);
}

/**
 * The highest revision a mutation may start from. The last safe revision is
 * kept for the system transition, so a plan a mutation left running can
 * always be paused at turn end or restart.
 */
const MAX_MUTATION_REVISION = Number.MAX_SAFE_INTEGER - 1;

function systemTransition(
  plan: ThreadPlan,
  reason: PlanPauseReason,
  turnId: string | null,
  now: string
): ThreadPlan | undefined {
  if (plan.revision >= Number.MAX_SAFE_INTEGER) return undefined;
  if (plan.status === "running") {
    return advance({ ...plan, status: "paused", pauseReason: reason, executionTurnId: null }, now, turnId);
  }
  if (plan.status === "blocked" && plan.executionTurnId !== null) {
    return advance({ ...plan, executionTurnId: null }, now, turnId);
  }
  return undefined;
}

function advance(plan: ThreadPlan, now: string, turnId: string | null): ThreadPlan {
  return { ...plan, revision: plan.revision + 1, updatedAt: now, lastModifiedTurnId: turnId };
}

function pendingStep(id: string, description: string): ThreadPlanStep {
  return { id, description, status: "pending", outcome: null, lastBlocker: null };
}
