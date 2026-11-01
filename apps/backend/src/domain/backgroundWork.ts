import { z } from "zod";
import { childReportTriggerSchema, parentTaskTriggerSchema } from "./childThreads";

/** Bounds a runner reports background work within, and the contract checks. */
export const BACKGROUND_TASK_LIMITS = {
  /** Live tasks listed on one session. */
  listed: 32,
  /** Finished tasks one agent-started turn names. */
  finishedPerTurn: 16,
  /** A task id, description or progress line. */
  text: 200
} as const;

/**
 * Work an agent runs beside its turns: a subagent or a shell command it sent
 * to the background. It can outlive the turn that started it. The runner
 * reports the live list; the session holds it in memory only, because the
 * tasks die with the runner's process.
 */
export const agentBackgroundTaskSchema = z.object({
  /** The runner's own task id; the stop route addresses it. */
  id: z.string().min(1).max(BACKGROUND_TASK_LIMITS.text),
  kind: z.enum(["agent", "shell", "other"]),
  description: z.string().min(1).max(BACKGROUND_TASK_LIMITS.text),
  /** The latest one-line status, when the runner reports one. */
  progress: z.string().max(BACKGROUND_TASK_LIMITS.text).optional(),
  /** The background task that launched this one, when it is still listed. */
  parentId: z.string().min(1).max(BACKGROUND_TASK_LIMITS.text).optional(),
  startedAt: z.string().min(1)
});

/** A background task that ended, as the agent was told about it. */
export const agentFinishedBackgroundTaskSchema = z.object({
  id: z.string().min(1).max(BACKGROUND_TASK_LIMITS.text),
  description: z.string().max(BACKGROUND_TASK_LIMITS.text).optional(),
  status: z.enum(["completed", "failed", "stopped"]),
  /** The runner's own bounded account of the outcome. */
  summary: z.string().max(500).optional()
});

/** A turn the agent started to answer background work that finished. */
export const agentBackgroundTaskTriggerSchema = z.object({
  kind: z.literal("background_task"),
  tasks: z.array(agentFinishedBackgroundTaskSchema).max(BACKGROUND_TASK_LIMITS.finishedPerTurn)
});

/**
 * Why a turn without a person's message started: background work finished, a
 * parent tasked its child, or children reported to their parent. Absent on
 * every turn a person started. Every kind carries `tasks`, empty outside
 * `background_task`.
 */
export const agentTurnTriggerSchema = z.discriminatedUnion("kind", [
  agentBackgroundTaskTriggerSchema,
  parentTaskTriggerSchema,
  childReportTriggerSchema
]);

export type AgentBackgroundTask = z.infer<typeof agentBackgroundTaskSchema>;
export type AgentFinishedBackgroundTask = z.infer<typeof agentFinishedBackgroundTaskSchema>;
export type AgentTurnTrigger = z.infer<typeof agentTurnTriggerSchema>;
export type AgentBackgroundTaskTrigger = z.infer<typeof agentBackgroundTaskTriggerSchema>;
