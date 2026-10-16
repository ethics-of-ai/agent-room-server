import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask, type AgentFinishedBackgroundTask } from "../../domain/backgroundWork";
import type { AgentRunnerBackgroundListener, AgentRunnerEvent, BackgroundTaskStopResult } from "../AgentRunner";
import { sameBackgroundTasks } from "../shared/backgroundTaskList";
import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { runnerMetadataFromNotification } from "./notificationMapper";
import { CodexBackgroundShells } from "./backgroundShells";
import type { CodexRequest } from "./backgroundTerminals";
import { CodexSubagents } from "./subagents";
import { fromThread } from "./threadRouting";

interface FinishedReply {
  task: AgentFinishedBackgroundTask;
  reply: string;
}

/**
 * One Codex app-server child's background work as one list: subagents, then
 * the shells subagents left running, then the session thread's shells. Each
 * source keeps its own state; this reports the merged list whenever it
 * changes.
 *
 * Codex never starts a turn when a subagent finishes. It queues the result
 * for the spawning agent, and a running turn reads that queue only if it
 * samples the model again, so a person may never see it. This posts the
 * subagent's last message as an agent-started turn of its own, with no model
 * call. A subagent that finishes during a session turn is held until that
 * turn settles. Replies that finish together share one turn, at most
 * `finishedPerTurn` of them. A turn the service refuses is dropped.
 */
export class CodexBackgroundWork {
  private readonly subagents: CodexSubagents;
  private readonly shells: CodexBackgroundShells;
  /** Shells on subagent threads, read when each of that thread's turns completes. */
  private readonly subagentShells = new Map<string, CodexBackgroundShells>();
  private reported = new Map<string, AgentBackgroundTask>();
  private replies: FinishedReply[] = [];
  private postScheduled = false;
  /** The latest AgentRoom turn this session ran, session or agent-started. */
  private latestRunId?: string;

  constructor(
    private readonly deps: {
      sessionId: string;
      request: CodexRequest;
      /** The session's own thread id, empty until `thread/start` answers. */
      threadId(): string;
      /** Whether a session turn is running. */
      busy(): boolean;
      listener(): AgentRunnerBackgroundListener | undefined;
    }
  ) {
    this.subagents = new CodexSubagents({
      request: deps.request,
      threadId: deps.threadId,
      changed: () => this.changed(),
      finished: (task, reply) => this.finished(task, reply)
    });
    this.shells = new CodexBackgroundShells({ request: deps.request, threadId: deps.threadId, report: () => this.changed() });
  }

  /** A session turn ended; an agent-started turn opened after it names it, and held replies go out. */
  turnEnded(runId: string): void {
    this.latestRunId = runId;
    if (this.replies.length > 0) this.schedulePost();
  }

  /**
   * True when the notification belongs to background work rather than a
   * session turn: anything from a subagent's thread, and a listed shell's
   * late events.
   */
  observe(notification: JsonRpcNotification): boolean {
    const threadId = runnerMetadataFromNotification(notification).nativeSessionId;
    if (this.subagents.observe(notification)) {
      if (threadId) this.observeSubagentShells(threadId, notification);
      return true;
    }
    // A subagent dropped from the bounded list can still have shells listed.
    const leftover = threadId ? this.subagentShells.get(threadId) : undefined;
    if (leftover) {
      leftover.observe(notification);
      return true;
    }
    if (!fromThread(this.deps.threadId(), notification)) return false;
    return this.shells.observe(notification);
  }

  /** Read the session thread's shells again; called when each of its turns completes. */
  refresh(): Promise<void> {
    return this.shells.refresh();
  }

  async stop(taskId: string): Promise<BackgroundTaskStopResult> {
    if (this.subagents.isRunning(taskId)) return this.subagents.stop(taskId);
    for (const shells of [this.shells, ...this.subagentShells.values()]) {
      if (shells.has(taskId)) return shells.stop(taskId);
    }
    return "unknown_task";
  }

  get hasLiveTasks(): boolean {
    if (this.subagents.hasLiveTasks || this.shells.hasLiveTasks) return true;
    for (const shells of this.subagentShells.values()) if (shells.hasLiveTasks) return true;
    return false;
  }

  list(): AgentBackgroundTask[] {
    const tasks = this.subagents.list();
    for (const [threadId, shells] of this.subagentShells) {
      tasks.push(...shells.list(this.subagents.isRunning(threadId) ? threadId : undefined));
    }
    tasks.push(...this.shells.list());
    return tasks.slice(0, BACKGROUND_TASK_LIMITS.listed);
  }

  /** The child is gone, and its work with it. Reports an empty list if one was showing. */
  reset(): void {
    this.subagents.reset();
    this.shells.reset();
    for (const shells of this.subagentShells.values()) shells.reset();
    this.subagentShells.clear();
    this.replies = [];
    this.changed();
  }

  /**
   * A subagent's turn can leave shells running, as the session's can. They
   * die with the child, so they are listed and keep it from being reaped.
   */
  private observeSubagentShells(threadId: string, notification: JsonRpcNotification): void {
    let shells = this.subagentShells.get(threadId);
    if (!shells) {
      shells = new CodexBackgroundShells({ request: this.deps.request, threadId: () => threadId, report: () => this.changed() });
      this.subagentShells.set(threadId, shells);
    }
    shells.observe(notification);
    if (notification.method !== "turn/completed") return;
    const read = shells;
    void read.refresh().then(() => {
      // A thread with nothing running and no shells left is read again only if it starts another turn.
      if (!read.hasLiveTasks && !this.subagents.isRunning(threadId) && this.subagentShells.get(threadId) === read) {
        this.subagentShells.delete(threadId);
      }
    });
  }

  private changed(): void {
    const tasks = this.list();
    const next = new Map(tasks.map((task) => [task.id, task]));
    if (sameBackgroundTasks(this.reported, next)) return;
    this.reported = next;
    this.deps.listener()?.tasksChanged({ sessionId: this.deps.sessionId, tasks });
  }

  private finished(task: AgentFinishedBackgroundTask, reply: string): void {
    if (this.replies.length >= BACKGROUND_TASK_LIMITS.finishedPerTurn) return;
    this.replies.push({ task, reply });
    if (!this.deps.busy()) this.schedulePost();
  }

  private schedulePost(): void {
    if (this.postScheduled) return;
    this.postScheduled = true;
    setImmediate(() => {
      this.postScheduled = false;
      this.postReplies();
    });
  }

  /** Post every held reply in one turn. While a session turn runs they wait for `turnEnded`. */
  private postReplies(): void {
    if (this.replies.length === 0 || this.deps.busy()) return;
    const replies = this.replies;
    this.replies = [];
    this.deps.listener()?.turnStarted({
      sessionId: this.deps.sessionId,
      ...(this.latestRunId ? { afterRunId: this.latestRunId } : {}),
      finished: replies.map((entry) => entry.task),
      start: (runId) => {
        this.latestRunId = runId;
        return replyEvents(replies);
      }
    });
  }
}

async function* replyEvents(replies: FinishedReply[]): AsyncIterable<AgentRunnerEvent> {
  const message = replies.length === 1
    ? replies[0]?.reply ?? ""
    : replies.map((entry) => `**${entry.task.description ?? "Subagent"}**\n\n${entry.reply}`).join("\n\n");
  yield { type: "agent_update", message };
  yield { type: "run_succeeded", message: "Codex subagent finished" };
}
