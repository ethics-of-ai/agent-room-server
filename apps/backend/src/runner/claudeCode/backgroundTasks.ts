import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask, type AgentFinishedBackgroundTask } from "../../domain/backgroundWork";
import { arrayValue, booleanValue, objectValue, stringValue } from "../shared/jsonValues";
import { backgroundTaskText, redactedTaskText, sameBackgroundTasks } from "../shared/backgroundTaskList";

// The CLI's own task list is unbounded; at most `listed` tasks are reported.
// Progress lines change per subagent step. Membership changes report at once;
// a change to progress alone waits this long so a busy subagent cannot flood
// the event stream.
const PROGRESS_REPORT_INTERVAL_MS = 1_000;
// At most `finishedPerTurn` finished tasks are held for the next agent-started
// turn. More in one gap between turns are counted by the CLI's own
// notification text anyway.

const FINISHED_STATUSES = new Set(["completed", "failed", "stopped"]);

/**
 * One Claude Code child's background tasks, read from the SDK's task messages.
 *
 * `system/background_tasks_changed` is the source of the live list: a level
 * signal with replace semantics, so a missed edge cannot leave a stale entry.
 * `task_progress` only updates the status line of a listed task. Foreground
 * tool calls emit task messages too (`is_backgrounded: false`), so a task
 * counts as background work only once the level signal has listed it or its
 * start said it was backgrounded. Entries the CLI flags `ambient` are
 * housekeeping and are never listed.
 *
 * Notifications for background tasks are held until the turn that answers
 * them. The agent-started turn they trigger takes them. The result that
 * settles a person's turn clears them, because the CLI folds a notification
 * that arrives during that turn into it. One that arrives during an
 * agent-started turn waits for the next one, because the CLI answers it in a
 * turn of its own. An interrupted turn's trailing result clears nothing.
 *
 * The CLI can run a subagent again under the same `task_id` with a new
 * `run_id`. The re-run is listed afresh, with a new start time and no
 * progress line.
 */
export class ClaudeCodeBackgroundTasks {
  private live = new Map<string, AgentBackgroundTask>();
  /** Tasks whose progress line is the model-written summary; a step description no longer replaces it. */
  private readonly summarized = new Set<string>();
  private readonly backgrounded = new Set<string>();
  private readonly descriptions = new Map<string, string>();
  /** The CLI's run id for each listed task. A re-run keeps its task id under a new one. */
  private readonly runIds = new Map<string, string | undefined>();
  private finished: AgentFinishedBackgroundTask[] = [];
  private progressTimer?: NodeJS.Timeout;

  constructor(private readonly report: (tasks: AgentBackgroundTask[]) => void) {}

  /** Read one SDK message. Messages that are not about tasks are ignored. */
  observe(message: unknown): void {
    const object = objectValue(message);
    if (!object || stringValue(object.type) !== "system") return;
    switch (stringValue(object.subtype)) {
      case "background_tasks_changed":
        this.replace(arrayValue(object.tasks));
        return;
      case "task_started":
        this.remember(object);
        if (booleanValue(object.is_backgrounded)) this.markBackgrounded(object);
        return;
      case "task_updated":
        if (booleanValue(objectValue(object.patch)?.is_backgrounded)) this.markBackgrounded(object);
        return;
      case "task_progress":
        this.progress(object);
        return;
      case "task_notification":
        this.notify(object);
        return;
      default:
        return;
    }
  }

  get hasLiveTasks(): boolean {
    return this.live.size > 0;
  }

  list(): AgentBackgroundTask[] {
    return [...this.live.values()].slice(0, BACKGROUND_TASK_LIMITS.listed).map((task) => ({ ...task }));
  }

  isLive(taskId: string): boolean {
    return this.live.has(taskId);
  }

  /** The background tasks that finished since the last turn ended, emptied by the read. */
  takeFinished(): AgentFinishedBackgroundTask[] {
    const finished = this.finished;
    this.finished = [];
    return finished;
  }

  /** A person's turn settled with its own result: anything it was told about is answered. */
  turnEnded(): void {
    this.finished = [];
  }

  /** The child is gone, and its tasks with it. Reports an empty list if one was showing. */
  reset(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    const hadTasks = this.live.size > 0;
    this.live = new Map();
    this.summarized.clear();
    this.backgrounded.clear();
    this.descriptions.clear();
    this.runIds.clear();
    this.finished = [];
    if (hadTasks) this.report([]);
  }

  private replace(entries: unknown[]): void {
    const next = new Map<string, AgentBackgroundTask>();
    for (const entry of entries) {
      const object = objectValue(entry);
      const id = stringValue(object?.task_id);
      if (!object || !id || booleanValue(object.ambient)) continue;
      this.backgrounded.add(id);
      const description = backgroundTaskText(object.description) ?? this.descriptions.get(id) ?? "Background task";
      this.descriptions.set(id, description);
      const runId = stringValue(object.run_id);
      const previous = this.runIds.get(id) === runId ? this.live.get(id) : undefined;
      if (!previous) this.summarized.delete(id);
      this.runIds.set(id, runId);
      next.set(id, {
        id,
        kind: taskKind(stringValue(object.task_type)),
        description,
        ...(previous?.progress ? { progress: previous.progress } : {}),
        startedAt: previous?.startedAt ?? new Date().toISOString()
      });
    }
    // A parent is named only while it is itself listed; the CLI keeps ids of
    // ended or foreground launchers that a client has no row for.
    for (const entry of entries) {
      const object = objectValue(entry);
      const task = next.get(stringValue(object?.task_id) ?? "");
      const parentId = stringValue(object?.parent_task_id);
      if (task && parentId && next.has(parentId)) task.parentId = parentId;
    }
    for (const id of this.summarized) if (!next.has(id)) this.summarized.delete(id);
    for (const id of this.runIds.keys()) if (!next.has(id)) this.runIds.delete(id);
    const changed = !sameBackgroundTasks(this.live, next);
    this.live = next;
    if (changed) this.reportNow();
  }

  private progress(object: Record<string, unknown>): void {
    const id = stringValue(object.task_id);
    const task = id ? this.live.get(id) : undefined;
    if (!id || !task) return;
    const summary = backgroundTaskText(object.summary);
    if (summary) this.summarized.add(id);
    const line = summary ?? (this.summarized.has(id) ? undefined : backgroundTaskText(object.description));
    if (!line || line === task.progress) return;
    task.progress = line;
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.report(this.list());
    }, PROGRESS_REPORT_INTERVAL_MS);
  }

  private notify(object: Record<string, unknown>): void {
    const id = stringValue(object.task_id);
    const status = stringValue(object.status);
    if (!id || !status || !FINISHED_STATUSES.has(status)) return;
    if (booleanValue(object.ambient) || booleanValue(object.skip_transcript)) return;
    if (!this.backgrounded.has(id) && !this.live.has(id)) return;
    if (this.finished.length >= BACKGROUND_TASK_LIMITS.finishedPerTurn) return;
    const description = this.live.get(id)?.description ?? this.descriptions.get(id);
    const summary = redactedTaskText(object.summary);
    this.finished.push({
      id,
      status: status as AgentFinishedBackgroundTask["status"],
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {})
    });
  }

  private remember(object: Record<string, unknown>): void {
    const id = stringValue(object.task_id);
    const description = backgroundTaskText(object.description);
    if (id && description) this.descriptions.set(id, description);
  }

  private markBackgrounded(object: Record<string, unknown>): void {
    const id = stringValue(object.task_id);
    if (id) this.backgrounded.add(id);
  }

  private reportNow(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.report(this.list());
  }
}

function taskKind(taskType: string | undefined): AgentBackgroundTask["kind"] {
  if (taskType === "local_agent") return "agent";
  if (taskType === "local_bash") return "shell";
  return "other";
}
