import type { AgentRoomEvent, AgentRoomEventType } from "../events/eventTypes";

export interface AuditLogEntry {
  id: string;
  type: AgentRoomEventType;
  at: string;
  sessionId?: string;
  workspaceId?: string;
  workspacePath?: string;
  title?: string;
  state?: string;
  message?: string;
  error?: string;
  audit?: unknown;
}

export interface AuditLogStore {
  initialize(): Promise<void>;
  attach(eventBus: { subscribe(handler: (event: AgentRoomEvent) => void): () => void }): () => void;
  append(event: AgentRoomEvent): Promise<void>;
  flush(): Promise<void>;
  getRecent(limit?: number): AuditLogEntry[];
}
