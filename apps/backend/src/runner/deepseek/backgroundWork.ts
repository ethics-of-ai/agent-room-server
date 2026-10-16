import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask, type AgentFinishedBackgroundTask } from "../../domain/backgroundWork";
import type { AgentRunnerBackgroundListener } from "../AgentRunner";
import { backgroundTaskText, redactedTaskText, sameBackgroundTasks } from "../shared/backgroundTaskList";
import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { DEEPSEEK_WAKE_BUDGET } from "./cordis/composition";
import type { BackgroundStopTarget } from "./cordis/protocol";
import { objectValue } from "../shared/jsonValues";
import {
  assistantMessageDataSchema,
  jobRegisteredDataSchema,
  jobSettledDataSchema,
  subagentFinishedNotificationSchema,
  subagentStartedNotificationSchema,
  toolCallDataSchema,
  toolResultDataSchema,
  turnEndDataSchema,
  type DeepSeekSessionEventNotification
} from "./protocol";

type FinishedStatus = AgentFinishedBackgroundTask["status"];

interface ListedSubagent {
  /** The row without `parentId`, which `list` derives from what is still listed. */
  task: AgentBackgroundTask;
  parentSessionId: string;
  /** The child's latest assistant text, reported as its summary when it ends. */
  lastText?: string;
}

interface ListedJob {
  /** The row without `parentId`, which `list` derives from what is still listed. */
  task: AgentBackgroundTask;
  owner: string;
  callKey?: string;
  /** Listed once its call asked for the background or returned while it ran. */
  listed: boolean;
  /** The model killed it with `job_kill`, whose result already told the model. */
  killedByModel?: boolean;
}

/**
 * One DeepSeek runtime's background work, read from its wire.
 *
 * The job registry records every shell call as a job, foreground ones
 * included. A foreground job settles inside its call, before the call's
 * result; a background job is still running when the result arrives. So a
 * job is listed when its call asked for `run_in_background`, or when its
 * call's result arrives while it runs (a foreground call promoted on
 * timeout). `job/settled` removes it. A subagent is listed from
 * `subagent.started`, named after the `subagent` call that started it, until
 * its own turn ends; `subagent.finished` can arrive after the parent's turn
 * that reports it, so it is only the fallback. A subagent's background jobs
 * list under it while it is listed.
 *
 * A task that ends is held as finished until a turn takes it, but only when
 * the runtime tells the root agent: a root job the model did not kill itself,
 * or a subagent the root started. A subagent's own jobs report to the
 * subagent. A turn takes what it holds when it settles, because the runtime
 * folds an ending that arrives during any turn into that turn, and the turn
 * the runtime starts for an ending takes what is held when it opens.
 */
export class DeepSeekBackgroundWork {
  /** Calls that asked for `run_in_background`, keyed by session and call id. */
  private readonly backgroundCalls = new Set<string>();
  private readonly jobs = new Map<string, ListedJob>();
  private readonly subagents = new Map<string, ListedSubagent>();
  /**
   * `subagent` calls not yet matched to a started child, per calling session.
   * `subagent.started` follows its call and precedes the call's result, which
   * drops a call that started nothing.
   */
  private readonly pendingSubagentCalls = new Map<string, Array<{ callId: string; description: string }>>();
  private reported = new Map<string, AgentBackgroundTask>();
  private finished: AgentFinishedBackgroundTask[] = [];
  /** Turns the runtime started on its own since a person's last turn. */
  private agentTurns = 0;

  constructor(
    private readonly deps: {
      sessionId: string;
      listener(): AgentRunnerBackgroundListener | undefined;
      /** Tell the runtime's AgentRoom plugin to refuse or allow new subagents. */
      pauseSubagents(paused: boolean): void;
    }
  ) {}

  /** `sessionEvent` is the notification already parsed as a session event, when it is one. */
  observe(notification: JsonRpcNotification, sessionEvent: DeepSeekSessionEventNotification | undefined): void {
    if (notification.method === "subagent.started") return this.subagentStarted(notification.params);
    if (notification.method === "subagent.finished") return this.subagentFinished(notification.params);
    if (!sessionEvent) return;
    const { sessionId, event } = sessionEvent;
    if (event.type === "tool/call") this.toolCalled(sessionId, event.data);
    else if (event.type === "tool/result") this.toolReturned(sessionId, event.data);
    else if (event.type === "job/registered") this.jobRegistered(event.data);
    else if (event.type === "job/settled") this.jobSettled(event.data);
    else if (event.type === "assistant/message") this.subagentSaid(sessionId, event.data);
    else if (event.type === "turn/end") this.subagentTurnEnded(sessionId, event.data);
  }

  /** The runtime is gone, and its jobs and subagents with it. */
  reset(): void {
    this.backgroundCalls.clear();
    this.jobs.clear();
    this.subagents.clear();
    this.pendingSubagentCalls.clear();
    this.finished = [];
    this.agentTurns = 0;
    this.changed();
  }

  /** What the runtime needs to stop a listed task, or nothing for one this does not list. */
  stopTarget(taskId: string): BackgroundStopTarget | undefined {
    const subagent = this.subagents.get(taskId);
    if (subagent) return { kind: "subagent", childSessionId: taskId, parentSessionId: subagent.parentSessionId };
    const job = this.jobs.get(taskId);
    return job?.listed ? { kind: "job", jobId: taskId, owner: job.owner } : undefined;
  }

  /** The tasks that ended since a turn last took them. */
  takeFinished(): AgentFinishedBackgroundTask[] {
    const finished = this.finished;
    this.finished = [];
    return finished;
  }

  /**
   * Count a turn the runtime started on its own. Upstream caps job wakes at
   * the same budget, but a subagent's ending wakes its idle parent without
   * one, and a woken turn can start another subagent. So once the budget's
   * worth of such turns run in a row, the plugin refuses new subagents.
   */
  agentTurnStarted(): void {
    this.agentTurns += 1;
    if (this.agentTurns === DEEPSEEK_WAKE_BUDGET) this.deps.pauseSubagents(true);
  }

  /** A person's turn lifts the pause, as a person's message refills the job wake budget upstream. */
  personTurnStarted(): void {
    if (this.agentTurns >= DEEPSEEK_WAKE_BUDGET) this.deps.pauseSubagents(false);
    this.agentTurns = 0;
  }

  private toolCalled(sessionId: string, data: unknown): void {
    const call = toolCallDataSchema.omit({ arguments: true }).safeParse(data);
    if (!call.success) return;
    const args = objectValue(parseArguments(objectValue(data)?.arguments));
    if (call.data.name === "subagent") {
      const description = backgroundTaskText(args?.description) ?? backgroundTaskText(args?.prompt) ?? "Subagent";
      this.pendingSubagentCalls.set(sessionId, [...this.pendingSubagentCalls.get(sessionId) ?? [], { callId: call.data.callId, description }]);
    }
    if (call.data.name === "job_kill" && typeof args?.job_id === "string") {
      const job = this.jobs.get(args.job_id);
      if (job) job.killedByModel = true;
    }
    if (args?.run_in_background === true) {
      this.backgroundCalls.add(callKey(sessionId, call.data.callId));
    }
  }

  private toolReturned(sessionId: string, data: unknown): void {
    const result = toolResultDataSchema.safeParse(data);
    const callId = result.success ? result.data.message?.source?.callId : undefined;
    if (!callId) return;
    const key = callKey(sessionId, callId);
    this.backgroundCalls.delete(key);
    const calls = this.pendingSubagentCalls.get(sessionId)?.filter((call) => call.callId !== callId);
    if (calls) this.pendingSubagentCalls.set(sessionId, calls);
    for (const job of this.jobs.values()) {
      if (job.callKey === key) job.listed = true;
    }
    this.changed();
  }

  private jobRegistered(data: unknown): void {
    const job = jobRegisteredDataSchema.safeParse(data);
    if (!job.success) return;
    const description = backgroundTaskText(job.data.label) ?? job.data.kind;
    const key = job.data.toolCall?.callId ? callKey(job.data.owner, job.data.toolCall.callId) : undefined;
    this.jobs.set(job.data.jobId, {
      task: {
        id: job.data.jobId.slice(0, BACKGROUND_TASK_LIMITS.text),
        kind: job.data.kind === "bash" || job.data.kind === "pwsh" ? "shell" : "other",
        description: description || "Background job",
        startedAt: new Date(job.data.startedAt).toISOString()
      },
      owner: job.data.owner,
      ...(key ? { callKey: key } : {}),
      listed: key !== undefined && this.backgroundCalls.has(key)
    });
    this.changed();
  }

  private jobSettled(data: unknown): void {
    const job = jobSettledDataSchema.safeParse(data);
    const listed = job.success ? this.jobs.get(job.data.jobId) : undefined;
    if (!job.success || !listed) return;
    this.jobs.delete(job.data.jobId);
    if (listed.listed && !listed.killedByModel && listed.owner === this.deps.sessionId) {
      const summary = redactedTaskText(job.data.detail);
      this.ended({
        id: listed.task.id,
        description: listed.task.description,
        status: jobStatus(job.data.status),
        ...(summary ? { summary } : {})
      });
    }
    this.changed();
  }

  private subagentStarted(params: unknown): void {
    const started = subagentStartedNotificationSchema.safeParse(params);
    if (!started.success || this.subagents.has(started.data.childSessionId)) return;
    const calls = this.pendingSubagentCalls.get(started.data.parentSessionId) ?? [];
    const description = calls.shift()?.description ?? "Subagent";
    this.subagents.set(started.data.childSessionId, {
      task: {
        id: started.data.childSessionId.slice(0, BACKGROUND_TASK_LIMITS.text),
        kind: "agent",
        description,
        startedAt: new Date().toISOString()
      },
      parentSessionId: started.data.parentSessionId
    });
    this.changed();
  }

  private subagentSaid(sessionId: string, data: unknown): void {
    const subagent = this.subagents.get(sessionId);
    const message = subagent ? assistantMessageDataSchema.safeParse(data) : undefined;
    if (!subagent || !message?.success) return;
    const text = (message.data.message?.content ?? []).flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("");
    if (text.trim()) subagent.lastText = text;
  }

  private subagentTurnEnded(sessionId: string, data: unknown): void {
    if (!this.subagents.has(sessionId)) return;
    const end = turnEndDataSchema.safeParse(data);
    this.subagentEnded(sessionId, turnEndStatus(end.success ? end.data.reason?.kind : undefined));
  }

  private subagentFinished(params: unknown): void {
    const finished = subagentFinishedNotificationSchema.safeParse(params);
    if (!finished.success) return;
    this.subagentEnded(finished.data.childSessionId, subagentFinishedStatus(finished.data.status, finished.data.stopReason));
  }

  private subagentEnded(childSessionId: string, status: FinishedStatus): void {
    const subagent = this.subagents.get(childSessionId);
    if (!subagent) return;
    this.subagents.delete(childSessionId);
    if (subagent.parentSessionId === this.deps.sessionId) {
      const summary = redactedTaskText(subagent.lastText);
      this.ended({ id: subagent.task.id, description: subagent.task.description, status, ...(summary ? { summary } : {}) });
    }
    this.changed();
  }

  private ended(task: AgentFinishedBackgroundTask): void {
    if (this.finished.length < BACKGROUND_TASK_LIMITS.finishedPerTurn) this.finished.push(task);
  }

  private list(): AgentBackgroundTask[] {
    const underSubagent = (task: AgentBackgroundTask, sessionId: string): AgentBackgroundTask => {
      const parentId = this.subagents.get(sessionId)?.task.id;
      return parentId ? { ...task, parentId } : task;
    };
    return [
      ...[...this.subagents.values()].map((subagent) => underSubagent(subagent.task, subagent.parentSessionId)),
      ...[...this.jobs.values()].filter((job) => job.listed).map((job) => underSubagent(job.task, job.owner))
    ].slice(0, BACKGROUND_TASK_LIMITS.listed);
  }

  private changed(): void {
    const tasks = this.list();
    const next = new Map(tasks.map((task) => [task.id, task]));
    if (sameBackgroundTasks(this.reported, next)) return;
    this.reported = next;
    this.deps.listener()?.tasksChanged({ sessionId: this.deps.sessionId, tasks });
  }
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

/** The log types call arguments as JSON text, but a route can record the parsed object. */
function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A job registry outcome: `completed`, `killed` or `failed`. */
function jobStatus(status: string): FinishedStatus {
  return status === "completed" ? "completed" : status === "killed" ? "stopped" : "failed";
}

/** A `turn/end` reason kind. */
function turnEndStatus(kind: string | undefined): FinishedStatus {
  return kind === "completed" ? "completed" : kind === "aborted" ? "stopped" : "failed";
}

/** `subagent.finished` reports `ok` or an error, with the loop's stop reason. */
function subagentFinishedStatus(status: string, stopReason: string | undefined): FinishedStatus {
  return status === "ok" ? "completed" : stopReason === "aborted" ? "stopped" : "failed";
}
