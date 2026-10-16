import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask } from "../../domain/backgroundWork";
import { logger } from "../../logging/logger";
import type { BackgroundTaskStopResult } from "../AgentRunner";
import { backgroundTaskText, sameBackgroundTasks } from "../shared/backgroundTaskList";
import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { nonnegativeIntegerValue, objectValue, stringValue } from "../shared/jsonValues";
import { type CodexRequest, parseBackgroundTerminal, readBackgroundTerminals, terminateBackgroundTerminal } from "./backgroundTerminals";

// Start times of commands that have not ended yet. Codex's list carries no
// start time, so a listed shell takes its time from here. An entry goes when
// its command's `item/completed` arrives. Bounded, oldest dropped first, so a
// turn of many short commands cannot grow it.
const STARTED_LIMIT = 256;

/**
 * One Codex thread's background shells: the session's own, or a subagent's.
 *
 * A unified-exec command can outlive the tool call that started it: the call
 * returns while the process keeps running, and its one `item/completed`
 * arrives when the process exits, still carrying the turn it started in.
 * Nothing on the item says whether it will outlive its turn, so the live
 * list comes from `thread/backgroundTerminals/list`,
 * a level read taken when each turn completes. Between reads, a listed
 * shell's `item/completed` removes it. A shell's late events belong to no
 * running turn, so `observe` claims them.
 */
export class CodexBackgroundShells {
  private live = new Map<string, AgentBackgroundTask>();
  /** The app-server's process id for each listed shell, which `terminate` takes. */
  private processIds = new Map<string, string>();
  private readonly startedAtMs = new Map<string, number>();
  /** Commands that ended while a list read was in flight; its answer may still name them. */
  private readonly endedDuringRead = new Set<string>();
  private readsInFlight = 0;
  private generation = 0;

  constructor(
    private readonly deps: {
      request: CodexRequest;
      /** The thread these shells run on, empty until it is known. */
      threadId(): string;
      report(tasks: AgentBackgroundTask[]): void;
    }
  ) {}

  /** Read one notification from this thread. True when it belongs to a listed shell. */
  observe(notification: JsonRpcNotification): boolean {
    const params = objectValue(notification.params);
    const item = objectValue(params?.item);
    const itemId = stringValue(params?.itemId) ?? stringValue(item?.id);
    if (!itemId) return false;
    const isCommand = stringValue(item?.type) === "commandExecution";
    if (notification.method === "item/started" && isCommand) {
      this.rememberStart(itemId, nonnegativeIntegerValue(params?.startedAtMs) ?? Date.now());
      return false;
    }
    if (notification.method === "item/completed" && isCommand) {
      this.startedAtMs.delete(itemId);
      if (this.readsInFlight > 0) this.endedDuringRead.add(itemId);
      this.processIds.delete(itemId);
      if (!this.live.delete(itemId)) return false;
      this.deps.report(this.list());
      return true;
    }
    return this.live.has(itemId);
  }

  /** Replace the list with the app-server's own. A failed read keeps the current list. */
  async refresh(): Promise<void> {
    const threadId = this.deps.threadId();
    if (!threadId) return;
    const generation = ++this.generation;
    this.endedDuringRead.clear();
    let terminals: unknown[];
    this.readsInFlight += 1;
    try {
      terminals = await readBackgroundTerminals(this.deps.request, threadId);
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, "Codex background terminal list failed");
      return;
    } finally {
      this.readsInFlight -= 1;
    }
    if (generation !== this.generation) return;
    this.replace(terminals);
  }

  /** Ask the app-server to end one listed shell. Its `item/completed` removes it. */
  async stop(taskId: string): Promise<BackgroundTaskStopResult> {
    const processId = this.processIds.get(taskId);
    if (!processId) return "unknown_task";
    return await terminateBackgroundTerminal(this.deps.request, this.deps.threadId(), processId) ? "stopped" : "unknown_task";
  }

  has(taskId: string): boolean {
    return this.live.has(taskId);
  }

  get hasLiveTasks(): boolean {
    return this.live.size > 0;
  }

  /** The listed shells, each naming `parentId` when one is given. */
  list(parentId?: string): AgentBackgroundTask[] {
    return [...this.live.values()].map((task) => ({ ...task, ...(parentId ? { parentId } : {}) }));
  }

  /** The child is gone, and its shells with it. Reports an empty list if one was showing. */
  reset(): void {
    this.generation += 1;
    this.startedAtMs.clear();
    this.endedDuringRead.clear();
    const hadTasks = this.live.size > 0;
    this.live = new Map();
    this.processIds = new Map();
    if (hadTasks) this.deps.report([]);
  }

  private replace(terminals: unknown[]): void {
    const next = new Map<string, AgentBackgroundTask>();
    const processIds = new Map<string, string>();
    for (const entry of terminals) {
      const terminal = parseBackgroundTerminal(entry);
      if (!terminal || this.endedDuringRead.has(terminal.itemId)) continue;
      if (next.size >= BACKGROUND_TASK_LIMITS.listed) break;
      const { itemId: id, processId, command } = terminal;
      const startedAtMs = this.startedAtMs.get(id);
      processIds.set(id, processId);
      next.set(id, {
        id,
        kind: "shell",
        description: backgroundTaskText(command) ?? "Background command",
        startedAt: this.live.get(id)?.startedAt ?? new Date(startedAtMs ?? Date.now()).toISOString()
      });
    }
    const changed = !sameBackgroundTasks(this.live, next);
    this.live = next;
    this.processIds = processIds;
    if (changed) this.deps.report(this.list());
  }

  private rememberStart(itemId: string, startedAtMs: number): void {
    this.startedAtMs.set(itemId, startedAtMs);
    if (this.startedAtMs.size <= STARTED_LIMIT) return;
    const oldest = this.startedAtMs.keys().next().value;
    if (oldest !== undefined) this.startedAtMs.delete(oldest);
  }
}
