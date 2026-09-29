import { z } from "zod";

/**
 * The stored shape of a thread plan and its mutation receipts: the single
 * owner of plan statuses, bounds, and structural invariants. Tool inputs,
 * transitions, the durable document schema, and the shared Apple DTOs
 * derive from these definitions rather than restating them. The contract is
 * docs/engineering/RUNNERS.md#thread-plan-tools and docs/api/API.md#thread-plans.
 */

export const PLAN_STATUSES = ["draft", "running", "blocked", "paused", "completed", "cancelled"] as const;
export const PLAN_STEP_STATUSES = ["pending", "in_progress", "blocked", "completed", "skipped"] as const;
export const PLAN_PAUSE_REASONS = ["turn_ended", "turn_failed", "turn_cancelled", "backend_restarted"] as const;
export const PLAN_MUTATION_TOOL_IDS = [
  "plans.create",
  "plans.edit",
  "plans.execute",
  "plans.update_step",
  "plans.finish"
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
export type PlanPauseReason = (typeof PLAN_PAUSE_REASONS)[number];
export type PlanMutationToolId = (typeof PLAN_MUTATION_TOOL_IDS)[number];

/** Every count, text, and byte limit in the contract's Bounds table. */
export const PLAN_LIMITS = {
  minSteps: 1,
  maxSteps: 64,
  objectiveChars: 2_048,
  completionCriteriaChars: 4_096,
  stepDescriptionChars: 1_024,
  noteChars: 1_024,
  summaryChars: 2_048,
  idChars: 128,
  operationIdChars: 128,
  mutationInputBytes: 40 * 1024,
  storedPlanBytes: 32 * 1024,
  /** Model-authored candidates leave 1 KiB for backend lifecycle metadata. */
  candidatePlanBytes: 31 * 1024,
  resultBytes: 40 * 1024,
  contextBytes: 2 * 1024,
  receipts: 64,
  receiptBytes: 1024
} as const;

export const TERMINAL_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set(["completed", "cancelled"]);
export const RESOLVED_STEP_STATUSES: ReadonlySet<PlanStepStatus> = new Set(["completed", "skipped"]);

const ASCII_ID = /^[\x21-\x7e]+$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]+$/;

export const planIdentifierSchema = z.string().min(1).max(PLAN_LIMITS.idChars).regex(ASCII_ID, "must be printable ASCII");
export const planOperationIdSchema = z
  .string()
  .min(1)
  .max(PLAN_LIMITS.operationIdChars)
  .regex(OPERATION_ID, "must match [A-Za-z0-9._:-]+");
export const planRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Nonempty after trimming, bounded in UTF-16 code units, stored as given. */
export const planText = (maxChars: number) =>
  z.string().max(maxChars).refine((value) => value.trim().length > 0, "must not be empty or whitespace");

export const planStepSchema = z.object({
  id: planIdentifierSchema,
  description: planText(PLAN_LIMITS.stepDescriptionChars),
  status: z.enum(PLAN_STEP_STATUSES),
  outcome: planText(PLAN_LIMITS.noteChars).nullable(),
  lastBlocker: planText(PLAN_LIMITS.noteChars).nullable()
});

const timestamp = z.string().datetime();

const planObjectSchema = z.object({
  id: planIdentifierSchema,
  revision: planRevisionSchema,
  objective: planText(PLAN_LIMITS.objectiveChars),
  completionCriteria: planText(PLAN_LIMITS.completionCriteriaChars),
  steps: z.array(planStepSchema).min(PLAN_LIMITS.minSteps).max(PLAN_LIMITS.maxSteps),
  status: z.enum(PLAN_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastModifiedTurnId: planIdentifierSchema.nullable(),
  executionTurnId: planIdentifierSchema.nullable(),
  pauseReason: z.enum(PLAN_PAUSE_REASONS).nullable(),
  resumeNote: planText(PLAN_LIMITS.noteChars).nullable(),
  summary: planText(PLAN_LIMITS.summaryChars).nullable()
});

export type ThreadPlanStep = z.infer<typeof planStepSchema>;
export type ThreadPlan = z.infer<typeof planObjectSchema>;

/** The stored plan: field bounds, structural invariants, and the byte ceiling. */
export const threadPlanSchema = planObjectSchema.superRefine((plan, context) => {
  const issue = planInvariantIssue(plan) ?? planSizeIssue(plan, PLAN_LIMITS.storedPlanBytes);
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const planMutationReceiptSchema = z.object({
  operationId: planOperationIdSchema,
  toolId: z.enum(PLAN_MUTATION_TOOL_IDS),
  argumentsHash: z.string().regex(/^[0-9a-f]{64}$/),
  planId: planIdentifierSchema,
  revision: planRevisionSchema,
  turnId: planIdentifierSchema.nullable()
});

export type PlanMutationReceipt = z.infer<typeof planMutationReceiptSchema>;

/** The plan fields of one durable session document. */
export interface PlanPersistedState {
  plan: ThreadPlan | null;
  planMutationReceipts: PlanMutationReceipt[];
}

export const EMPTY_PLAN_STATE: Readonly<PlanPersistedState> = Object.freeze({ plan: null, planMutationReceipts: [] });

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function planSizeIssue(plan: ThreadPlan, limitBytes: number): string | undefined {
  const bytes = serializedBytes(plan);
  return bytes > limitBytes ? `plan is ${bytes} bytes; the limit is ${limitBytes}` : undefined;
}

/** Index of the first unresolved step, or `steps.length` when all are resolved. */
export function currentStepIndex(plan: Pick<ThreadPlan, "steps">): number {
  const index = plan.steps.findIndex((step) => !RESOLVED_STEP_STATUSES.has(step.status));
  return index === -1 ? plan.steps.length : index;
}

export function allStepsResolved(plan: Pick<ThreadPlan, "steps">): boolean {
  return currentStepIndex(plan) === plan.steps.length;
}

/**
 * The structural rules every stored or candidate plan satisfies: resolved
 * steps form a prefix, at most one step is active (in progress or blocked)
 * and it is the current step, step ids are unique, and plan status agrees
 * with step status. Returns a short reason, or undefined when valid.
 */
export function planInvariantIssue(plan: ThreadPlan): string | undefined {
  const ids = new Set(plan.steps.map((step) => step.id));
  if (ids.size !== plan.steps.length) return "step ids must be unique";
  const current = currentStepIndex(plan);
  if (plan.steps.slice(current).some((step) => RESOLVED_STEP_STATUSES.has(step.status))) {
    return "resolved steps must form a prefix";
  }
  const active = plan.steps.filter((step) => step.status === "in_progress" || step.status === "blocked");
  if (active.length > 1) return "at most one step may be in progress or blocked";
  if (active.length === 1 && plan.steps[current] !== active[0]) return "the active step must be the current step";
  const blockedStep = active[0]?.status === "blocked";
  if (plan.status === "blocked" && !blockedStep) return "a blocked plan needs a blocked current step";
  if (plan.status !== "blocked" && blockedStep && !TERMINAL_PLAN_STATUSES.has(plan.status)) {
    return "a blocked step requires a blocked plan";
  }
  if (plan.status === "draft" && plan.steps.some((step) => step.status !== "pending")) {
    return "a draft plan has only pending steps";
  }
  if (plan.status === "running" && plan.executionTurnId === null) return "a running plan needs an execution turn";
  if (plan.status !== "running" && plan.status !== "blocked" && plan.executionTurnId !== null) {
    return "only a running or blocked plan has an execution turn";
  }
  if ((plan.status === "paused") !== (plan.pauseReason !== null)) return "only a paused plan has a pause reason";
  if (TERMINAL_PLAN_STATUSES.has(plan.status) !== (plan.summary !== null)) return "only a finished plan has a summary";
  return undefined;
}
