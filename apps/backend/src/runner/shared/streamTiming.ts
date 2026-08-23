import type { AgentRunnerEvent } from "../AgentRunner";

export interface RunnerStreamTiming {
  firstEventAtMs?: number;
  firstOutputAtMs?: number;
  lastOutputAtMs?: number;
  lastEventAtMs?: number;
  maxOutputGapMs?: number;
  eventCount: number;
  outputEventCount: number;
  outputBytes: number;
  activityEventCount: number;
}

export function createRunnerStreamTiming(): RunnerStreamTiming {
  return {
    eventCount: 0,
    outputEventCount: 0,
    outputBytes: 0,
    activityEventCount: 0
  };
}

export function observeRunnerStreamEvent(timing: RunnerStreamTiming, event: AgentRunnerEvent): void {
  if (event.type === "runner_audit") return;
  const now = Date.now();
  timing.firstEventAtMs ??= now;
  timing.lastEventAtMs = now;
  timing.eventCount += 1;
  if (event.type === "agent_update") {
    timing.firstOutputAtMs ??= now;
    if (timing.lastOutputAtMs !== undefined) {
      timing.maxOutputGapMs = Math.max(timing.maxOutputGapMs ?? 0, now - timing.lastOutputAtMs);
    }
    timing.lastOutputAtMs = now;
    timing.outputEventCount += 1;
    timing.outputBytes += Buffer.byteLength(event.message, "utf8");
  } else if (event.type === "agent_activity") {
    timing.activityEventCount += 1;
  }
}

export function runnerStreamTimingAudit(timing: RunnerStreamTiming, startedAtMs: number): {
  timeToFirstEventMs?: number;
  timeToFirstOutputMs?: number;
  streamDurationMs?: number;
  maxOutputGapMs?: number;
  eventCount: number;
  outputEventCount: number;
  outputBytes: number;
  activityEventCount: number;
} {
  return {
    ...(timing.firstEventAtMs ? { timeToFirstEventMs: timing.firstEventAtMs - startedAtMs } : {}),
    ...(timing.firstOutputAtMs ? { timeToFirstOutputMs: timing.firstOutputAtMs - startedAtMs } : {}),
    ...(timing.firstEventAtMs && timing.lastEventAtMs ? { streamDurationMs: timing.lastEventAtMs - timing.firstEventAtMs } : {}),
    ...(timing.maxOutputGapMs !== undefined ? { maxOutputGapMs: timing.maxOutputGapMs } : {}),
    eventCount: timing.eventCount,
    outputEventCount: timing.outputEventCount,
    outputBytes: timing.outputBytes,
    activityEventCount: timing.activityEventCount
  };
}
