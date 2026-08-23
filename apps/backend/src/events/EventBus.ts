import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentRoomEvent, AgentRoomEventType } from "./eventTypes";

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly recent: AgentRoomEvent[] = [];

  constructor(private readonly maxRecentEvents = 200) {}

  publish<TPayload>(type: AgentRoomEventType, payload: TPayload): AgentRoomEvent<TPayload> {
    const event = this.createEvent(type, payload);
    this.recent.push(event);
    while (this.recent.length > this.maxRecentEvents) {
      this.recent.shift();
    }
    this.emitter.emit("event", event);
    return event;
  }

  createTransient<TPayload>(type: AgentRoomEventType, payload: TPayload): AgentRoomEvent<TPayload> {
    return this.createEvent(type, payload);
  }

  subscribe(handler: (event: AgentRoomEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  getRecentEvents(limit = 100, options: { excludeTypes?: AgentRoomEventType[] } = {}): AgentRoomEvent[] {
    const excludedTypes = new Set(options.excludeTypes ?? []);
    const events = excludedTypes.size > 0 ? this.recent.filter((event) => !excludedTypes.has(event.type)) : this.recent;
    return events.slice(-limit);
  }

  private createEvent<TPayload>(type: AgentRoomEventType, payload: TPayload): AgentRoomEvent<TPayload> {
    return {
      id: randomUUID(),
      type,
      at: new Date().toISOString(),
      payload
    };
  }
}
