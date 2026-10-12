import { randomUUID } from "node:crypto";
import type { AgentRunnerKind, AgentTurnContext, CodingAgentTurnSettings } from "../domain/models";

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
