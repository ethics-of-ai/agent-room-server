import type { AgentSession, AgentSessionTurn } from "../domain/models";
import { logger } from "../logging/logger";
import type { AgentRunnerEvent } from "../runner/AgentRunner";

interface AgentTurnTelemetry {
  requestStartedAtMs: number;
  acceptedAtMs: number;
  runnerStartedAtMs?: number;
  firstRunnerEventAtMs?: number;
  lastRunnerEventAtMs?: number;
  firstAssistantDeltaAtMs?: number;
  lastAssistantDeltaAtMs?: number;
  maxAssistantDeltaGapMs?: number;
  runnerEventCount: number;
  assistantDeltaCount: number;
  assistantBytes: number;
  activityEventCount: number;
}

export class AgentTurnTelemetryStore {
  private readonly telemetry = new Map<string, AgentTurnTelemetry>();

  accept(turnId: string, requestStartedAtMs: number, acceptedAtMs: number): void {
    this.telemetry.set(turnId, {
      requestStartedAtMs,
      acceptedAtMs,
      runnerEventCount: 0,
      assistantDeltaCount: 0,
      assistantBytes: 0,
      activityEventCount: 0
    });
  }

  markRunnerStarted(turnId: string): { runnerStartedAtMs?: number; requestStartedAtMs?: number } {
    const telemetry = this.telemetry.get(turnId);
    if (!telemetry) return {};
    telemetry.runnerStartedAtMs = Date.now();
    return {
      runnerStartedAtMs: telemetry.runnerStartedAtMs,
      requestStartedAtMs: telemetry.requestStartedAtMs
    };
  }

  recordRunnerEvent(turn: AgentSessionTurn, event: AgentRunnerEvent): void {
    const telemetry = this.telemetry.get(turn.id);
    if (!telemetry) return;

    const now = Date.now();
    telemetry.firstRunnerEventAtMs ??= now;
    telemetry.lastRunnerEventAtMs = now;
    telemetry.runnerEventCount += 1;

    if (event.type === "agent_update") {
      telemetry.firstAssistantDeltaAtMs ??= now;
      if (telemetry.lastAssistantDeltaAtMs !== undefined) {
        telemetry.maxAssistantDeltaGapMs = Math.max(telemetry.maxAssistantDeltaGapMs ?? 0, now - telemetry.lastAssistantDeltaAtMs);
      }
      telemetry.lastAssistantDeltaAtMs = now;
      telemetry.assistantDeltaCount += 1;
      telemetry.assistantBytes += Buffer.byteLength(event.message, "utf8");
    } else if (event.type === "agent_activity") {
      telemetry.activityEventCount += 1;
    }
  }

  logTurnTiming(
    session: AgentSession,
    turn: AgentSessionTurn,
    status: "succeeded" | "failed" | "cancelled"
  ): void {
    const telemetry = this.telemetry.get(turn.id);
    if (!telemetry) return;
    const completedAtMs = Date.now();
    logger.info({
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      runnerKind: session.runnerKind,
      status,
      acceptDurationMs: telemetry.acceptedAtMs - telemetry.requestStartedAtMs,
      ...(telemetry.runnerStartedAtMs ? { timeToRunnerStartMs: telemetry.runnerStartedAtMs - telemetry.requestStartedAtMs } : {}),
      ...(telemetry.firstRunnerEventAtMs ? { timeToFirstRunnerEventMs: telemetry.firstRunnerEventAtMs - telemetry.requestStartedAtMs } : {}),
      ...(telemetry.firstAssistantDeltaAtMs ? { timeToFirstAssistantDeltaMs: telemetry.firstAssistantDeltaAtMs - telemetry.requestStartedAtMs } : {}),
      ...(telemetry.firstAssistantDeltaAtMs && telemetry.lastAssistantDeltaAtMs
        ? { assistantStreamDurationMs: telemetry.lastAssistantDeltaAtMs - telemetry.firstAssistantDeltaAtMs }
        : {}),
      ...(telemetry.maxAssistantDeltaGapMs !== undefined ? { maxAssistantDeltaGapMs: telemetry.maxAssistantDeltaGapMs } : {}),
      ...(telemetry.lastRunnerEventAtMs ? { runnerStreamDurationMs: telemetry.lastRunnerEventAtMs - telemetry.firstRunnerEventAtMs! } : {}),
      totalTurnDurationMs: completedAtMs - telemetry.requestStartedAtMs,
      runnerEventCount: telemetry.runnerEventCount,
      activityEventCount: telemetry.activityEventCount,
      assistantDeltaCount: telemetry.assistantDeltaCount,
      assistantBytes: telemetry.assistantBytes
    }, "Agent turn stream timing");
    this.telemetry.delete(turn.id);
  }

  delete(turnId: string): void {
    this.telemetry.delete(turnId);
  }
}
