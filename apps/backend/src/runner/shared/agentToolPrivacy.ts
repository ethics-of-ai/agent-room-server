import { agentToolByName } from "../../agentTools/catalog";

/**
 * AgentRoom catalog tools carry private arguments and results: plan text,
 * sketch geometry, question answers. A transport's activity mapping uses this
 * to keep them out of `agent_turn_activity`, which reaches `/api/events` and
 * the recent-event buffer. The tool's name and call id still show.
 */
export function isAgentRoomToolName(name: string | undefined): boolean {
  return name !== undefined && agentToolByName(name) !== undefined;
}
