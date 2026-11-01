import { randomUUID } from "node:crypto";
import type { AgentTurnTrigger } from "../domain/backgroundWork";
import type { AgentSessionMessageOrigin, AgentSessionParent } from "../domain/childThreads";
import type { AgentRunnerKind, AgentSession, AgentSessionMessage, AgentSessionTurn, AgentTurnContext, CodingAgentTurnSettings } from "../domain/models";

/**
 * The coded refusals a turn start meets: a child thread that is closed, or
 * whose Close, Land or Update is running its Git calls.
 */
export type AgentSessionRefusalCode = "child_closed" | "child_closing" | "child_merging";

export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    /** A machine-readable refusal, sent beside the message where a route passes it on. */
    readonly code?: AgentSessionRefusalCode
  ) {
    super(message);
  }
}

export interface CreateAgentSessionInput {
  workspaceId: string;
  runnerKind?: AgentRunnerKind;
  gitBranch?: string;
  settings?: CodingAgentTurnSettings;
  title?: string;
  /** Only the child-thread service passes this; the public route does not accept it. */
  parent?: AgentSessionParent;
}

/**
 * Why the backend, not a person, opens a turn, and the text it opens with. The
 * text is recorded with role `system` and `kind` as its `origin`, the turn
 * carries the trigger, and the text is the runner's input. The public turn
 * route never accepts one.
 */
export interface AgentTurnOrigin {
  kind: AgentSessionMessageOrigin;
  trigger: AgentTurnTrigger;
  message: string;
}

/** A person's turn names its `message`; a backend-started turn names its `origin` instead. */
export type StartAgentTurnInput = {
  sessionId: string;
  context?: AgentTurnContext;
  settings?: CodingAgentTurnSettings;
} & ({ message: string; origin?: undefined } | { message?: undefined; origin: AgentTurnOrigin });

/**
 * The one listener the child-thread layer installs on the session service.
 * `admitTurn` throws an `AgentSessionError` to refuse a turn before anything
 * is recorded; it runs before and again after `startTurn`'s awaits.
 * `turnEvent` runs after each runner event of any turn and once more when the
 * turn's event stream ends, after a runner's own waiting turn has had its
 * chance to open.
 */
export interface AgentSessionTurnObserver {
  admitTurn(session: AgentSession): void;
  turnEvent(session: AgentSession, turn: AgentSessionTurn): void;
}

/**
 * The fixed reason a turn that was running when the backend ended settles
 * with. A restart is an interruption, not a decision: nobody chose, so the
 * turn fails rather than being reported as cancelled or completed.
 */
/**
 * What a new turn opens with: the message at the head of its transcript, and
 * for a turn the agent started, why. `id` is preset when the runner needed the
 * turn id before the turn could open.
 */
export type AgentTurnOpening = Pick<AgentSessionMessage, "role" | "content" | "context" | "origin"> & Pick<AgentSessionTurn, "trigger"> & { id?: string };

export const BACKEND_RESTARTED_TURN_ERROR = "Backend restarted during this turn";

export function agentSessionId(): string {
  return `agent-session-${randomUUID()}`;
}

export function agentTurnId(): string {
  return `agent-turn-${randomUUID()}`;
}

export function hasSettings(settings: CodingAgentTurnSettings | undefined): settings is CodingAgentTurnSettings {
  return Boolean(settings?.model || settings?.reasoningEffort || settings?.serviceTier);
}
