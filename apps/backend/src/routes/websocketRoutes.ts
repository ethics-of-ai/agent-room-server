import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { EventBus } from "../events/EventBus";
import type { AgentRoomEvent, AgentRoomEventType } from "../events/eventTypes";
import type { AgentSessionService } from "../agent/AgentSessionService";

// A socket whose send buffer exceeds the drop threshold stops receiving
// delta-class events: each is superseded by later data, and clients re-seed
// transcript/artifact/token state from REST when a turn settles or on
// reconnect. A socket past the close threshold is disconnected outright so a
// stalled client cannot grow backend memory without bound during a turn.
const sendBufferDropThresholdBytes = 1_536 * 1024;
const sendBufferCloseThresholdBytes = 16 * 1024 * 1024;

const droppableUnderBackpressure = new Set<AgentRoomEventType>([
  "agent_turn_update",
  "agent_turn_activity",
  "agent_turn_token_usage_updated",
  "coding_assistant_message_delta",
  "coding_tool_activity_updated",
  "coding_token_usage_updated",
  "coding_artifact_delta"
]);

// One published event fans out to every connected socket; serialize once and
// share the string across subscriptions instead of stringifying per socket.
const serializedEvents = new WeakMap<AgentRoomEvent, string>();

function serializeEvent(event: AgentRoomEvent): string {
  let serialized = serializedEvents.get(event);
  if (serialized === undefined) {
    serialized = JSON.stringify(event);
    serializedEvents.set(event, serialized);
  }
  return serialized;
}

export async function registerWebsocketRoutes(
  app: FastifyInstance,
  deps: { eventBus: EventBus; agentSessions: AgentSessionService }
): Promise<void> {
  await app.register(websocket);

  app.get("/api/events", { websocket: true }, (socket, request) => {
    const streamOptions = websocketStreamOptions(request.url);
    socket.send(JSON.stringify(deps.eventBus.createTransient("status_snapshot", {
      snapshot: deps.agentSessions.getStatusSnapshot(recentEventsForStream(deps.eventBus, streamOptions))
    })));
    let droppedEventCount = 0;
    const unsubscribe = deps.eventBus.subscribe((event) => {
      if (!shouldStreamEvent(event, streamOptions)) return;
      if (socket.readyState !== socket.OPEN) return;
      const bufferedAmount = socket.bufferedAmount ?? 0;
      if (bufferedAmount > sendBufferCloseThresholdBytes) {
        app.log.warn({ bufferedAmount, droppedEventCount }, "Event stream client stalled; closing socket");
        socket.close(1013, "Event stream backpressure");
        return;
      }
      if (bufferedAmount > sendBufferDropThresholdBytes && droppableUnderBackpressure.has(event.type)) {
        droppedEventCount += 1;
        if (droppedEventCount === 1 || droppedEventCount % 500 === 0) {
          app.log.warn(
            { bufferedAmount, droppedEventCount, eventType: event.type },
            "Event stream backpressure; dropping delta events"
          );
        }
        return;
      }
      const serialized = serializeEvent(event);
      const queuedAtMs = Date.now();
      const eventAgeMs = eventAgeMsFromNow(event.at, queuedAtMs);
      socket.send(serialized, (error: Error | undefined) => {
        if (!isTurnStreamEvent(event.type)) return;
        const sendDurationMs = Date.now() - queuedAtMs;
        const slow = eventAgeMs > 250 || sendDurationMs > 250;
        // Building the log payload costs a byteLength scan per send; skip it
        // entirely on the healthy path unless debug logging is on.
        if (!error && !slow && !isDebugLogEnabled(app)) return;
        const logPayload = {
          eventId: event.id,
          eventType: event.type,
          eventAgeMs,
          sendDurationMs,
          payloadBytes: Buffer.byteLength(serialized, "utf8"),
          ...eventPayloadIds(event.payload)
        };
        if (error) {
          app.log.warn({ ...logPayload, error }, "Event stream send failed");
        } else if (slow) {
          app.log.warn(logPayload, "Slow event stream send");
        } else {
          app.log.debug(logPayload, "Event stream send timing");
        }
      });
    });
    socket.on("close", unsubscribe);
  });
}

function isDebugLogEnabled(app: FastifyInstance): boolean {
  const log = app.log as { isLevelEnabled?: (level: string) => boolean };
  return log.isLevelEnabled?.("debug") ?? false;
}

interface WebsocketStreamOptions {
  includeLegacyTurnEvents: boolean;
}

// Artifact deltas can be 64 KB each; replaying up to 200 of them would make the
// greeting frame multi-megabyte. Clients reconstruct artifact state from
// GET /api/agent-sessions/:id/artifacts instead, so the deltas stay live-only.
const replayExcludedEventTypes: AgentRoomEventType[] = ["status_snapshot", "coding_artifact_delta"];
const legacyTurnEventTypes: AgentRoomEventType[] = ["agent_turn_update", "agent_turn_activity"];

function websocketStreamOptions(url: string | undefined): WebsocketStreamOptions {
  const params = new URL(url ?? "/api/events", "http://agentroom.local").searchParams;
  const legacyTurnEvents = params.get("legacyTurnEvents") ?? params.get("legacyTurnUpdates");
  return {
    includeLegacyTurnEvents: booleanQueryValue(legacyTurnEvents, true)
  };
}

function booleanQueryValue(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no"].includes(normalized)) return false;
  if (["1", "true", "yes"].includes(normalized)) return true;
  return defaultValue;
}

function recentEventsForStream(eventBus: EventBus, options: WebsocketStreamOptions): AgentRoomEvent[] {
  const excludeTypes = options.includeLegacyTurnEvents
    ? replayExcludedEventTypes
    : [...replayExcludedEventTypes, ...legacyTurnEventTypes];
  return eventBus.getRecentEvents(200, { excludeTypes });
}

function shouldStreamEvent(event: AgentRoomEvent, options: WebsocketStreamOptions): boolean {
  return options.includeLegacyTurnEvents || !legacyTurnEventTypes.includes(event.type);
}

function isTurnStreamEvent(type: string): boolean {
  return type === "agent_turn_update" ||
    type === "agent_turn_activity" ||
    type === "agent_turn_succeeded" ||
    type === "agent_turn_failed" ||
    type === "agent_turn_cancelled" ||
    type.startsWith("coding_");
}

function eventAgeMsFromNow(at: string, nowMs: number): number {
  const eventAtMs = Date.parse(at);
  return Number.isFinite(eventAtMs) ? nowMs - eventAtMs : 0;
}

function eventPayloadIds(payload: unknown): { sessionId?: string; turnId?: string } {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {})
  };
}
