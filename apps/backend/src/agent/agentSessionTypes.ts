import { randomUUID } from "node:crypto";
import type { AgentRunnerKind, AgentSessionMessage, AgentSessionTurn, AgentTurnContext, CodingAgentTurnSettings } from "../domain/models";

export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
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
}

export interface StartAgentTurnInput {
  sessionId: string;
  message: string;
  context?: AgentTurnContext;
  settings?: CodingAgentTurnSettings;
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
export type AgentTurnOpening = Pick<AgentSessionMessage, "role" | "content" | "context"> & Pick<AgentSessionTurn, "trigger"> & { id?: string };

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
