import type { AgentBackgroundTask, AgentFinishedBackgroundTask } from "../../domain/backgroundWork";
import { logger } from "../../logging/logger";
import type { BackgroundTaskStopResult } from "../AgentRunner";
import { backgroundTaskText } from "../shared/backgroundTaskList";
import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { nonnegativeIntegerValue, objectValue, stringValue } from "../shared/jsonValues";
import { type CodexRequest, terminateBackgroundTerminals } from "./backgroundTerminals";
import { runnerMetadataFromNotification } from "./notificationMapper";

// Child threads remembered per app-server child, running or not. A follow-up
// can start another turn on any of them. Bounded, oldest dropped first.
const KNOWN_LIMIT = 256;

interface Subagent {
  description: string;
  /** The thread whose agent spawned this one: the session's, or another subagent's. */
  spawnedBy: string;
  startedAt: string;
  running: boolean;
  /** The child thread's running turn, once its `turn/started` arrived. */
  turnId?: string;
  /** The last message the subagent wrote in its running turn. */
  lastReply?: string;
  /** A stop asked for before the running turn's id was known; sent once `turn/started` names it. */
  stopRequested?: boolean;
}

/**
 * One Codex app-server child's subagents (multi-agent v2).
 *
 * A spawn reaches the spawning thread as a `subAgentActivity` item of kind
 * `started` that names the child thread. That item arrives before the child's
 * first `turn/started`. From then on the child thread's own `turn/*`
 * notifications say whether it is running. The spawning thread hears of a
 * finish through a `completed` item, but nothing when the child's turn is
 * interrupted, so those items are only a fallback for a child whose turn this
 * class never saw start. Only threads learned from a spawn are tracked;
 * the session's own thread and unknown threads are left to the caller.
 *
 * When a subagent the session's agent spawned completes or fails a turn, its
 * last message goes to `finished`. Codex starts no parent turn to relay it.
 * An interrupted turn, and a nested subagent, which answers its own spawner,
 * report nothing.
 */
export class CodexSubagents {
  private readonly known = new Map<string, Subagent>();

  constructor(
    private readonly deps: {
      request: CodexRequest;
      threadId(): string;
      changed(): void;
      finished(task: AgentFinishedBackgroundTask, reply: string): void;
    }
  ) {}

  /** True when the notification came from a subagent's thread; it then belongs to no session turn. */
  observe(notification: JsonRpcNotification): boolean {
    const params = objectValue(notification.params);
    const threadId = runnerMetadataFromNotification(notification).nativeSessionId;
    if (!threadId) return false;
    const fromSubagent = this.known.has(threadId);
    if (!fromSubagent && threadId !== this.deps.threadId()) return false;
    this.observeActivity(threadId, params);
    if (!fromSubagent) return false;
    const subagent = this.known.get(threadId);
    const turn = objectValue(params?.turn);
    const turnId = stringValue(turn?.id);
    const item = objectValue(params?.item);
    if (subagent && notification.method === "item/completed" && stringValue(item?.type) === "agentMessage") {
      subagent.lastReply = stringValue(item?.text) ?? subagent.lastReply;
    } else if (subagent && notification.method === "turn/started") {
      if (!subagent.running) subagent.startedAt = new Date().toISOString();
      subagent.running = true;
      subagent.turnId = turnId;
      subagent.lastReply = undefined;
      this.deps.changed();
      if (subagent.stopRequested && turnId) {
        subagent.stopRequested = undefined;
        // The stop route already answered; nothing is left to fail.
        this.interrupt(threadId, turnId).catch((error: unknown) => {
          logger.debug({ error: error instanceof Error ? error.message : String(error) }, "Codex subagent interrupt failed");
        });
      }
    } else if (subagent && notification.method === "turn/completed" && (!subagent.turnId || subagent.turnId === turnId)) {
      subagent.running = false;
      subagent.turnId = undefined;
      subagent.stopRequested = undefined;
      this.deps.changed();
      this.reportFinished(threadId, subagent, stringValue(turn?.status), stringValue(objectValue(turn?.error)?.message));
    }
    return true;
  }

  isRunning(taskId: string): boolean {
    return this.known.get(taskId)?.running === true;
  }

  /**
   * Interrupt the subagent's turn, then end the shells its thread left
   * running: an interrupted turn does not stop them. Its `turn/completed`
   * removes it from the list. A subagent is listed from its spawn, before its
   * turn's id is known; a stop then waits for `turn/started` to name it.
   */
  async stop(taskId: string): Promise<BackgroundTaskStopResult> {
    const subagent = this.known.get(taskId);
    if (!subagent?.running) return "unknown_task";
    if (!subagent.turnId) {
      subagent.stopRequested = true;
      return "stopped";
    }
    await this.interrupt(taskId, subagent.turnId);
    return "stopped";
  }

  get hasLiveTasks(): boolean {
    for (const subagent of this.known.values()) if (subagent.running) return true;
    return false;
  }

  list(): AgentBackgroundTask[] {
    const tasks: AgentBackgroundTask[] = [];
    for (const [id, subagent] of this.known) {
      if (!subagent.running) continue;
      const parentId = this.known.get(subagent.spawnedBy)?.running ? subagent.spawnedBy : undefined;
      tasks.push({ id, kind: "agent", description: subagent.description, ...(parentId ? { parentId } : {}), startedAt: subagent.startedAt });
    }
    return tasks;
  }

  reset(): void {
    this.known.clear();
  }

  private async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.deps.request("turn/interrupt", { threadId, turnId });
    try {
      await terminateBackgroundTerminals(this.deps.request, threadId);
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, "Codex subagent shell cleanup failed");
    }
  }

  private observeActivity(threadId: string, params: Record<string, unknown> | undefined): void {
    const item = objectValue(params?.item);
    if (stringValue(item?.type) !== "subAgentActivity") return;
    const childId = stringValue(item?.agentThreadId);
    if (!childId) return;
    const kind = stringValue(item?.kind);
    const existing = this.known.get(childId);
    if (kind === "started" && !existing) {
      const startedAtMs = nonnegativeIntegerValue(params?.startedAtMs) ?? nonnegativeIntegerValue(params?.completedAtMs) ?? Date.now();
      this.known.set(childId, {
        description: subagentName(item?.agentPath) ?? "Subagent",
        spawnedBy: threadId,
        startedAt: new Date(startedAtMs).toISOString(),
        running: true
      });
      this.forgetOldest();
      this.deps.changed();
    } else if ((kind === "completed" || kind === "interrupted") && existing?.running && !existing.turnId) {
      existing.running = false;
      this.deps.changed();
    }
  }

  private reportFinished(id: string, subagent: Subagent, status: string | undefined, error: string | undefined): void {
    if (subagent.spawnedBy !== this.deps.threadId()) return;
    // Codex's error text is not the subagent's own words, so it says where it came from.
    const failure = error ? `The subagent failed: ${error}` : "The subagent failed.";
    const reply = status === "failed" ? subagent.lastReply ?? failure : status === "completed" ? subagent.lastReply : undefined;
    subagent.lastReply = undefined;
    if (!reply) return;
    this.deps.finished({ id, status: status === "failed" ? "failed" : "completed", description: subagent.description }, reply);
  }

  private forgetOldest(): void {
    if (this.known.size <= KNOWN_LIMIT) return;
    for (const [id, subagent] of this.known) {
      if (subagent.running) continue;
      this.known.delete(id);
      return;
    }
  }
}

/** `/root/lead/sleep_task` becomes "sleep task": the name the spawning agent gave it. */
function subagentName(agentPath: unknown): string | undefined {
  const leaf = stringValue(agentPath)?.split("/").filter(Boolean).at(-1);
  return backgroundTaskText(leaf?.replace(/[_-]+/g, " "));
}
