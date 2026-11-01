import type { AgentBridgeMetrics, AgentSession, AgentSessionTurn } from "../domain/models";

/** A runner's token report. Undefined fields carry no new knowledge. */
export interface AgentTokenUsageReport {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindowUsedTokens?: number;
  modelContextWindowTokens?: number;
  /** Null is an authoritative clear from a runner that previously sent a value. */
  contextCompactionThresholdTokens?: number | null;
}

/**
 * The bridge-wide turn and token counters `/api/status` reports, and the token
 * fields each turn and session carries. Counters are process-scoped: a restart
 * starts them at zero, while the per-turn fields persist with the session.
 */
export class AgentSessionMetrics {
  private completedTurns = 0;
  private failedTurns = 0;
  private cancelledTurns = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;

  /** `changed` marks the session's durable record dirty after a usage update. */
  constructor(private readonly changed: (sessionId: string) => void) {}

  turnSucceeded(): void { this.completedTurns += 1; }
  turnFailed(): void { this.failedTurns += 1; }
  turnCancelled(): void { this.cancelledTurns += 1; }

  /** Applies a usage report to the turn and session, and moves the totals by the turn's delta. */
  recordTokenUsage(session: AgentSession, turn: AgentSessionTurn, event: AgentTokenUsageReport): void {
    const previousInputTokens = turn.inputTokens;
    const previousOutputTokens = turn.outputTokens;
    const previousTotalTokens = turn.totalTokens;
    if (typeof event.inputTokens === "number") turn.inputTokens = event.inputTokens;
    if (typeof event.outputTokens === "number") turn.outputTokens = event.outputTokens;
    if (typeof event.totalTokens === "number") turn.totalTokens = event.totalTokens;
    this.inputTokens += turn.inputTokens - previousInputTokens;
    this.outputTokens += turn.outputTokens - previousOutputTokens;
    this.totalTokens += turn.totalTokens - previousTotalTokens;
    // Occupancy is the latest request's footprint, never the cumulative
    // billed totals, which re-count cached context per tool round-trip.
    if (typeof event.contextWindowUsedTokens === "number") {
      session.contextWindowUsedTokens = event.contextWindowUsedTokens;
    }
    if (typeof event.modelContextWindowTokens === "number") {
      turn.modelContextWindowTokens = event.modelContextWindowTokens;
      session.modelContextWindowTokens = event.modelContextWindowTokens;
    }
    if (event.contextCompactionThresholdTokens === null) {
      delete turn.contextCompactionThresholdTokens;
      delete session.contextCompactionThresholdTokens;
    } else if (typeof event.contextCompactionThresholdTokens === "number") {
      turn.contextCompactionThresholdTokens = event.contextCompactionThresholdTokens;
      session.contextCompactionThresholdTokens = event.contextCompactionThresholdTokens;
    }
    session.updatedAt = new Date().toISOString();
    this.changed(session.id);
  }

  snapshot(sessions: Iterable<AgentSession>): AgentBridgeMetrics {
    const all = [...sessions];
    return {
      totalSessions: all.length,
      runningSessions: all.filter((session) => session.status === "running").length,
      completedTurns: this.completedTurns,
      failedTurns: this.failedTurns,
      cancelledTurns: this.cancelledTurns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens
    };
  }
}
