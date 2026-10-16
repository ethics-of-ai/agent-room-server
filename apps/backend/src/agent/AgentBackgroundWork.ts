import { BACKGROUND_TASK_LIMITS, type AgentBackgroundTask, type AgentFinishedBackgroundTask, type AgentTurnTrigger } from "../domain/backgroundWork";
import type { AgentSession, AgentSessionTurn } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { AgentRunnerBackgroundListener, AgentRunnerEvent } from "../runner/AgentRunner";
import { agentTurnId, type AgentTurnOpening } from "./agentSessionTypes";

/**
 * The session side of a runner's background work.
 *
 * The live task list rides the session record in memory and is broadcast as
 * `agent_background_tasks_changed` on every change, outside the replay
 * buffer: a reconnecting client reads the session instead. It is never
 * persisted, because the tasks die with the runner's process and a restored
 * list would only be stale.
 *
 * A turn the agent starts on its own becomes an ordinary AgentRoom turn with
 * no user message. A system message names what finished, and the turn
 * carries the same account as its `trigger`. From there it streams and
 * settles through the service's normal turn path, so notifications, unread
 * state and queued follow-ups treat it like any other turn.
 *
 * A person's running turn holds the session, so an agent turn is refused
 * then, and the runner folds the notification into that turn. A turn the
 * runner has already ended may still be settling, for instance while its Git
 * delta is read. An agent turn that starts then waits, and opens in the same
 * tick the settle frees the session.
 */
export class AgentBackgroundWork {
  /** The agent turn waiting for each session's settling turn, as the call that opens it. */
  private readonly waiting = new Map<string, () => void>();

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<string, AgentSession>;
      eventBus: EventBus;
      openTurn(session: AgentSession, opening: AgentTurnOpening): AgentSessionTurn;
      consume(session: AgentSession, turn: AgentSessionTurn, events: AsyncIterable<AgentRunnerEvent>): void;
    }
  ) {}

  readonly listener: AgentRunnerBackgroundListener = {
    tasksChanged: ({ sessionId, tasks }) => this.tasksChanged(sessionId, tasks),
    turnStarted: (input) => this.turnStarted(input)
  };

  /** An agent turn is waiting for this session's running turn to settle. */
  isWaiting(sessionId: string): boolean {
    return this.waiting.has(sessionId);
  }

  /** Open the agent turn waiting on this session, once nothing holds it. */
  openWaitingTurn(session: AgentSession): void {
    const open = this.waiting.get(session.id);
    if (!open || session.activeTurnId) return;
    this.waiting.delete(session.id);
    open();
  }

  forget(sessionId: string): void {
    this.waiting.delete(sessionId);
  }

  private tasksChanged(sessionId: string, tasks: AgentBackgroundTask[]): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;
    if (tasks.length > 0) {
      session.backgroundTasks = tasks;
    } else {
      delete session.backgroundTasks;
    }
    this.deps.eventBus.publishLive("agent_background_tasks_changed", { sessionId, workspaceId: session.workspaceId, tasks });
  }

  private turnStarted(input: {
    sessionId: string;
    afterRunId?: string;
    finished: AgentFinishedBackgroundTask[];
    start(runId: string): AsyncIterable<AgentRunnerEvent>;
  }): void {
    const session = this.deps.sessions.get(input.sessionId);
    if (!session || this.waiting.has(session.id)) return;
    const settling = session.activeTurnId !== undefined && session.activeTurnId === input.afterRunId;
    if (session.activeTurnId && !settling) return;
    const trigger: AgentTurnTrigger = { kind: "background_task", tasks: input.finished.slice(0, BACKGROUND_TASK_LIMITS.finishedPerTurn) };
    const id = agentTurnId();
    // Started at once, so the runner routes the turn's events from here on.
    const events = input.start(id);
    const open = () => {
      const turn = this.deps.openTurn(session, { id, role: "system", content: backgroundTurnMessage(trigger), trigger });
      this.deps.consume(session, turn, events);
    };
    if (settling) this.waiting.set(session.id, open);
    else open();
  }
}

/** The transcript line that opens an agent-started turn. */
export function backgroundTurnMessage(trigger: AgentTurnTrigger): string {
  const [first, ...rest] = trigger.tasks;
  if (!first) return "Background work finished.";
  if (rest.length === 0) {
    const verb = first.status === "completed" ? "finished" : first.status;
    return `Background task ${verb}: ${first.description ?? first.summary ?? "untitled"}`;
  }
  const names = trigger.tasks.map((task) => task.description ?? "untitled").join("; ");
  return `${trigger.tasks.length} background tasks ended: ${names}`;
}
