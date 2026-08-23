import { randomUUID } from "node:crypto";
import type {
  AgentSessionMessage,
  AgentSessionMessageStatus
} from "../domain/models";

export class AgentSessionMessageStore {
  private readonly messages = new Map<string, AgentSessionMessage[]>();

  initializeSession(sessionId: string): void {
    this.messages.set(sessionId, []);
  }

  list(sessionId: string): AgentSessionMessage[] {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  deleteSession(sessionId: string): void {
    this.messages.delete(sessionId);
  }

  append(input: Omit<AgentSessionMessage, "id">): AgentSessionMessage {
    const message: AgentSessionMessage = {
      id: agentMessageId(),
      ...input
    };
    const messages = this.messages.get(input.sessionId) ?? [];
    messages.push(message);
    this.messages.set(input.sessionId, messages);
    return message;
  }

  upsertAssistantMessage(
    sessionId: string,
    turnId: string,
    content: string,
    status: AgentSessionMessageStatus
  ): AgentSessionMessage {
    const messages = this.messages.get(sessionId) ?? [];
    // Streaming deltas update the newest message, so check the tail before
    // falling back to a scan; this runs once per assistant delta.
    const last = messages[messages.length - 1];
    const index = last && last.turnId === turnId && last.role === "assistant"
      ? messages.length - 1
      : messages.findIndex((message) => message.turnId === turnId && message.role === "assistant");
    if (index >= 0) {
      messages[index] = {
        ...messages[index],
        content,
        status,
        at: new Date().toISOString()
      };
      this.messages.set(sessionId, messages);
      return messages[index];
    }
    return this.append({
      sessionId,
      turnId,
      role: "assistant",
      content,
      status,
      at: new Date().toISOString()
    });
  }

  markAssistantMessage(
    sessionId: string,
    turnId: string,
    status: AgentSessionMessageStatus,
    fallbackContent = ""
  ): void {
    const messages = this.messages.get(sessionId) ?? [];
    const index = messages.findIndex((message) => message.turnId === turnId && message.role === "assistant");
    if (index >= 0) {
      messages[index] = {
        ...messages[index],
        status,
        at: new Date().toISOString()
      };
      this.messages.set(sessionId, messages);
      return;
    }
    if (fallbackContent) {
      this.append({
        sessionId,
        turnId,
        role: "assistant",
        content: fallbackContent,
        status,
        at: new Date().toISOString()
      });
    }
  }
}

function agentMessageId(): string {
  return `agent-message-${randomUUID()}`;
}
