import { z } from "zod";
import {
  PLAN_LIMITS,
  planIdentifierSchema,
  planOperationIdSchema,
  planRevisionSchema,
  planText,
  threadPlanSchema,
  type PlanMutationToolId,
  type ThreadPlan
} from "./planModel";

/**
 * The canonical zod input schema of each plan tool and the result envelope
 * every call returns. Catalog advertisements and native schemas derive from
 * these; handlers and transitions never re-validate by hand.
 */

export type PlanToolId = "plans.get" | PlanMutationToolId;

const target = { planId: planIdentifierSchema, expectedRevision: planRevisionSchema };

export const createPlanInputSchema = z
  .object({
    operationId: planOperationIdSchema,
    objective: planText(PLAN_LIMITS.objectiveChars),
    completionCriteria: planText(PLAN_LIMITS.completionCriteriaChars),
    steps: z
      .array(z.object({ description: planText(PLAN_LIMITS.stepDescriptionChars) }).strict())
      .min(PLAN_LIMITS.minSteps)
      .max(PLAN_LIMITS.maxSteps),
    replace: z.boolean().default(false),
    planId: planIdentifierSchema.optional(),
    expectedRevision: planRevisionSchema.optional()
  })
  .strict()
  .superRefine((input, context) => {
    const targeted = input.planId !== undefined || input.expectedRevision !== undefined;
    const complete = input.planId !== undefined && input.expectedRevision !== undefined;
    if (input.replace && !complete) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "replacement requires planId and expectedRevision" });
    }
    if (!input.replace && targeted) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "first creation takes no planId or expectedRevision" });
    }
  });

export const getPlanInputSchema = z.object({}).strict();

export const editPlanInputSchema = z
  .object({
    operationId: planOperationIdSchema,
    ...target,
    objective: planText(PLAN_LIMITS.objectiveChars),
    completionCriteria: planText(PLAN_LIMITS.completionCriteriaChars),
    steps: z
      .array(
        z.object({ id: planIdentifierSchema.optional(), description: planText(PLAN_LIMITS.stepDescriptionChars) }).strict()
      )
      .min(PLAN_LIMITS.minSteps)
      .max(PLAN_LIMITS.maxSteps)
  })
  .strict();

export const executePlanInputSchema = z
  .object({ operationId: planOperationIdSchema, ...target, resumeNote: planText(PLAN_LIMITS.noteChars).optional() })
  .strict();

export const updatePlanStepInputSchema = z
  .object({
    operationId: planOperationIdSchema,
    ...target,
    stepId: planIdentifierSchema,
    status: z.enum(["in_progress", "completed", "blocked", "skipped"]),
    note: planText(PLAN_LIMITS.noteChars).optional()
  })
  .strict()
  .superRefine((input, context) => {
    // A note on start is accepted and not kept: a step has nowhere to hold
    // one, and refusing it cost a live model a retry the schema never warned of.
    if (input.status !== "in_progress" && input.note === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `a ${input.status} step requires a note` });
    }
  });

export const finishPlanInputSchema = z
  .object({
    operationId: planOperationIdSchema,
    ...target,
    outcome: z.enum(["completed", "cancelled"]),
    summary: planText(PLAN_LIMITS.summaryChars)
  })
  .strict();

export const planToolInputSchemas = {
  "plans.create": createPlanInputSchema,
  "plans.get": getPlanInputSchema,
  "plans.edit": editPlanInputSchema,
  "plans.execute": executePlanInputSchema,
  "plans.update_step": updatePlanStepInputSchema,
  "plans.finish": finishPlanInputSchema
} as const satisfies Record<PlanToolId, z.ZodTypeAny>;

export type CreatePlanInput = z.infer<typeof createPlanInputSchema>;
export type EditPlanInput = z.infer<typeof editPlanInputSchema>;
export type ExecutePlanInput = z.infer<typeof executePlanInputSchema>;
export type UpdatePlanStepInput = z.infer<typeof updatePlanStepInputSchema>;
export type FinishPlanInput = z.infer<typeof finishPlanInputSchema>;
export type PlanMutationInput = CreatePlanInput | EditPlanInput | ExecutePlanInput | UpdatePlanStepInput | FinishPlanInput;

export const PLAN_ERROR_CODES = [
  "invalid_input",
  "limit_exceeded",
  "plan_not_found",
  "plan_conflict",
  "invalid_transition",
  "operation_conflict",
  "tools_unavailable",
  "turn_inactive",
  "persistence_failed",
  "outcome_unknown"
] as const;
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];

export const PLAN_RESULT_SCHEMA_VERSION = 1;

const planSuccessSchema = z
  .object({
    schemaVersion: z.literal(PLAN_RESULT_SCHEMA_VERSION),
    ok: z.literal(true),
    plan: threadPlanSchema.nullable(),
    operationId: planOperationIdSchema.optional(),
    appliedPlanId: planIdentifierSchema.optional(),
    appliedRevision: planRevisionSchema.optional(),
    replayed: z.boolean().optional(),
    readyToFinish: z.literal(true).optional()
  })
  .strict();

const planFailureSchema = z
  .object({
    schemaVersion: z.literal(PLAN_RESULT_SCHEMA_VERSION),
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(PLAN_ERROR_CODES),
        message: z.string().min(1).max(512),
        planId: planIdentifierSchema.optional(),
        revision: planRevisionSchema.optional()
      })
      .strict(),
    plan: threadPlanSchema.nullable()
  })
  .strict();

/** The decoded shape of every plan tool's JSON text result. */
export const planToolResultSchema = z.union([planSuccessSchema, planFailureSchema]);
export type PlanToolResult = z.infer<typeof planToolResultSchema>;

/** Conflict guidance shared by every refusal that depends on current state. */
export const PLAN_REREAD_GUIDANCE = "Call get_plan, reassess, and issue a new mutation with a new operationId.";

export function planFailure(
  code: PlanErrorCode,
  message: string,
  plan: ThreadPlan | null
): Extract<PlanToolResult, { ok: false }> {
  return {
    schemaVersion: PLAN_RESULT_SCHEMA_VERSION,
    ok: false,
    error: { code, message, ...(plan ? { planId: plan.id, revision: plan.revision } : {}) },
    plan
  };
}
