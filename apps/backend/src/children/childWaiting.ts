import type { EventBus } from "../events/EventBus";
import type { AgentRoomEvent } from "../events/eventTypes";
import type { OutstandingQuestionRequest } from "../agent/AgentTurnEventApplier";

const settledTurnEvents = new Set(["coding_turn_completed", "coding_turn_failed", "coding_turn_cancelled"]);

/**
 * Whether a child waits on a person: an unanswered permission request or an
 * open clarifying question in its running turn.
 *
 * Questions are already held by the session service. Permissions are not, so
 * this follows the canonical `coding_permission_requested` and
 * `coding_permission_resolved` events and keeps the open request ids per turn
 * in memory. A request without an id is one the runner answered from its own
 * policy, so nobody waits on it. A settled turn drops its requests. Only
 * children are tracked, so the map stays as small as the caps.
 */
export class ChildWaiting {
  /** Open permission request ids, by session and then turn. */
  private readonly permissions = new Map<string, Map<string, Set<string>>>();
  private unsubscribe?: () => void;

  constructor(
    private readonly deps: {
      eventBus: Pick<EventBus, "subscribe">;
      isChild(sessionId: string): boolean;
      outstandingQuestions(sessionId: string): OutstandingQuestionRequest[] | undefined;
    }
  ) {}

  start(): void {
    this.unsubscribe ??= this.deps.eventBus.subscribe((event) => this.observe(event));
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.permissions.clear();
  }

  waitingOn(sessionId: string): "permission" | "question" | undefined {
    const turns = this.permissions.get(sessionId);
    if (turns && [...turns.values()].some((requests) => requests.size > 0)) return "permission";
    return (this.deps.outstandingQuestions(sessionId)?.length ?? 0) > 0 ? "question" : undefined;
  }

  private observe(event: AgentRoomEvent): void {
    const payload = event.payload as { sessionId?: unknown; turnId?: unknown; requestId?: unknown } | undefined;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId) return;
    if (event.type === "agent_session_deleted") {
      this.permissions.delete(sessionId);
      return;
    }
    const turnId = typeof payload?.turnId === "string" ? payload.turnId : undefined;
    if (!turnId) return;
    if (settledTurnEvents.has(event.type)) {
      this.permissions.get(sessionId)?.delete(turnId);
      if (this.permissions.get(sessionId)?.size === 0) this.permissions.delete(sessionId);
      return;
    }
    const requestId = typeof payload?.requestId === "string" && payload.requestId.length > 0 ? payload.requestId : undefined;
    if (!requestId) return;
    if (event.type === "coding_permission_requested" && this.deps.isChild(sessionId)) {
      const turns = this.permissions.get(sessionId) ?? new Map<string, Set<string>>();
      const requests = turns.get(turnId) ?? new Set<string>();
      requests.add(requestId);
      turns.set(turnId, requests);
      this.permissions.set(sessionId, turns);
    } else if (event.type === "coding_permission_resolved") {
      this.permissions.get(sessionId)?.get(turnId)?.delete(requestId);
    }
  }
}
