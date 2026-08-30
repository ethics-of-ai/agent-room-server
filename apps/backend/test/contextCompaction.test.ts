import { describe, expect, it } from "vitest";
import type { AgentRunnerEvent, CanonicalActivity, RunnerMetadata } from "../src/runner/AgentRunner";
import { compactionThresholdFromContextUsage } from "../src/runner/claudeCode/contextUsage";
import { mapClaudeCodeMessage } from "../src/runner/claudeCode/messageMapper";
import { mapCodexNotification } from "../src/runner/codex/notificationMapper";
import { createCursorTurnState, mapCursorMessage } from "../src/runner/cursor/messageMapper";
import { codingEventFromRunnerActivity, codingTokenUsageUpdatedEvent } from "../src/protocol/coding/events";

/// Three of the four bundled runners announce their compaction on the wire, in
/// full or in part, and each announces it differently. These suites pin what
/// each adapter reads and — as much as anything else here — what it refuses to
/// pass on: the model's own summary of the conversation stops at the adapter.

const canonicalKinds = (events: AgentRunnerEvent[]): (string | undefined)[] =>
  events.map((event) => (event.type === "agent_activity" ? event.activity.canonical?.kind : event.type));

const canonicalOf = (events: AgentRunnerEvent[], index = 0): CanonicalActivity | undefined => {
  const event = events[index];
  return event?.type === "agent_activity" ? event.activity.canonical : undefined;
};

describe("Claude Code compaction mapping", () => {
  const map = (message: unknown): AgentRunnerEvent[] => mapClaudeCodeMessage(message, new Map());

  it("maps only the compacting status to a started compaction", () => {
    expect(canonicalKinds(map({ type: "system", subtype: "status", status: "compacting" })))
      .toEqual(["context_compaction_started"]);
    // `requesting` is an ordinary model call and `null` is the return to idle.
    expect(map({ type: "system", subtype: "status", status: "requesting" })).toEqual([]);
    expect(map({ type: "system", subtype: "status", status: null })).toEqual([]);
  });

  it("completes a compaction once: the boundary reports success, the status reports failure", () => {
    // The boundary already announced this one; completing it here too would
    // report one compaction twice.
    expect(map({ type: "system", subtype: "status", status: null, compact_result: "success" })).toEqual([]);

    const failed = map({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "the model refused to summarize /Users/me/secrets.env"
    });
    expect(canonicalOf(failed)).toEqual({ kind: "context_compaction_completed", failed: true });
    expect(JSON.stringify(failed)).not.toContain("secrets.env");
  });

  it("carries the boundary's trigger and counts, and corrects the badge with post_tokens", () => {
    const events = map({
      type: "system",
      subtype: "compact_boundary",
      session_id: "claude-session-1",
      compact_metadata: { trigger: "auto", pre_tokens: 154_000, post_tokens: 31_200, duration_ms: 8_400 }
    });

    expect(canonicalKinds(events)).toEqual(["context_compaction_completed", "token_usage_updated"]);
    expect(canonicalOf(events)).toEqual({
      kind: "context_compaction_completed",
      trigger: "auto",
      preTokens: 154_000,
      postTokens: 31_200
    });
    // The occupancy the thread reported was measured before the compaction, so
    // the drop and its cause land in the same tick on the ordinary usage path.
    expect(events[1]).toMatchObject({
      type: "token_usage_updated",
      contextWindowUsedTokens: 31_200,
      runner: { nativeSessionId: "claude-session-1" }
    });
  });

  it("reports a boundary with no counts, and corrects nothing", () => {
    const events = map({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 90 } });
    expect(canonicalKinds(events)).toEqual(["context_compaction_completed"]);
    expect(canonicalOf(events)).toEqual({ kind: "context_compaction_completed", trigger: "manual", preTokens: 90 });
  });

  it("reports no trigger for a value the SDK does not declare", () => {
    const events = map({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "scheduled", pre_tokens: 5 } });
    expect(canonicalOf(events)).toEqual({ kind: "context_compaction_completed", preTokens: 5 });
  });

  it("ignores a subagent compacting its own window", () => {
    // Its context is not this thread's, the same rule the occupancy read
    // applies. Neither compaction message declares `parent_tool_use_id` today
    // (SDK 0.3.172), so this pins a guard against the SDK growing one rather
    // than behavior the current wire can produce.
    for (const message of [
      { type: "system", subtype: "status", status: "compacting", parent_tool_use_id: "tool-1" },
      { type: "system", subtype: "status", status: null, compact_result: "failed", parent_tool_use_id: "tool-1" },
      {
        type: "system",
        subtype: "compact_boundary",
        parent_tool_use_id: "tool-1",
        compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 10 }
      }
    ]) {
      expect(map(message)).toEqual([]);
    }
  });
});

describe("Claude Code compaction threshold", () => {
  it("reads the threshold and explicitly clears it when auto-compaction is off", () => {
    expect(compactionThresholdFromContextUsage({
      totalTokens: 12_000,
      maxTokens: 200_000,
      percentage: 6,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 160_000
    })).toBe(160_000);

    // A threshold beside a disabled switch is a number that will never fire.
    expect(compactionThresholdFromContextUsage({
      isAutoCompactEnabled: false,
      autoCompactThreshold: 160_000
    })).toBeNull();
  });

  it("clears a previously known threshold when an enabled response has no usable number", () => {
    // `maxTokens` is deliberately never turned into a threshold: any fraction
    // of it would be a line AgentRoom drew, not one the child has.
    for (const usage of [
      { maxTokens: 200_000, isAutoCompactEnabled: true },
      { isAutoCompactEnabled: true, autoCompactThreshold: 0 },
      { isAutoCompactEnabled: true, autoCompactThreshold: -1 },
      { isAutoCompactEnabled: true, autoCompactThreshold: 160_000.5 }
    ]) {
      expect(compactionThresholdFromContextUsage(usage)).toBeNull();
    }
  });

  it("answers nothing when the control response is unavailable or malformed", () => {
    for (const usage of [
      undefined,
      null,
      "not an object",
      {},
      { maxTokens: 200_000, isAutoCompactEnabled: "true", autoCompactThreshold: 160_000 }
    ]) {
      expect(compactionThresholdFromContextUsage(usage)).toBeUndefined();
    }
  });
});

describe("Codex compaction mapping", () => {
  const notification = (method: string, params: Record<string, unknown>) =>
    mapCodexNotification({ jsonrpc: "2.0", method, params });

  it("maps the contextCompaction item to one started/completed pair", () => {
    const started = notification("item/started", { threadId: "thread-1", item: { id: "item-9", type: "contextCompaction" } });
    expect(canonicalOf(started)).toEqual({ kind: "context_compaction_started" });

    const completed = notification("item/completed", { threadId: "thread-1", item: { id: "item-9", type: "contextCompaction" } });
    expect(canonicalOf(completed)).toEqual({ kind: "context_compaction_completed" });
  });

  it("does not file a compaction as a tool call, and drops the item's own content", () => {
    const events = notification("item/completed", {
      item: { id: "item-9", type: "contextCompaction", summary: "everything the thread has done so far" }
    });
    const event = events[0];
    if (event?.type !== "agent_activity") throw new Error("expected an activity");
    expect(event.activity.kind).toBe("codex_context_compaction_completed");
    expect(event.activity.content).toEqual({});
    expect(JSON.stringify(events)).not.toContain("everything the thread has done");
  });

  it("leaves thread/compacted unmapped, so one compaction is never completed twice", () => {
    expect(notification("thread/compacted", { threadId: "thread-1" })).toEqual([]);
  });

  it("still maps an ordinary item as a tool call", () => {
    const started = notification("item/started", { item: { id: "item-1", type: "commandExecution", command: "ls" } });
    expect(canonicalKinds(started)).toEqual(["tool_started"]);
  });
});

describe("Cursor compaction mapping", () => {
  const base: RunnerMetadata = { nativeSessionId: "agent-1" };
  const map = (message: unknown): AgentRunnerEvent[] =>
    mapCursorMessage(message, { runId: "run-1", base, state: createCursorTurnState() });

  it("maps the summary task message to a completed compaction and copies its text nowhere", () => {
    const summary = "The user asked for the auth flow, then we renamed three files under apps/backend.";
    const events = map({ type: "task", text: summary });

    expect(canonicalOf(events)).toEqual({ kind: "context_compaction_completed" });
    const event = events[0];
    if (event?.type !== "agent_activity") throw new Error("expected an activity");
    expect(event.activity.content).toEqual({});
    expect(JSON.stringify(events)).not.toContain("auth flow");
  });

  it("leaves a task carrying a status unread, and an empty one silent", () => {
    expect(map({ type: "task", text: "summary", status: "started" })).toEqual([]);
    expect(map({ type: "task", text: "" })).toEqual([]);
    expect(map({ type: "task" })).toEqual([]);
  });
});

describe("canonical compaction events", () => {
  const eventFor = (canonical: CanonicalActivity) =>
    codingEventFromRunnerActivity({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      // A runner id no file in `protocol/coding` mentions: the mapper dispatches
      // on the canonical kind alone, so these need no adapter it knows about.
      runnerKind: "acp_demo",
      activity: { kind: "acp_session_update", title: "Agent update", content: {}, canonical }
    });

  it("maps both kinds for a runner the mapper has never heard of", () => {
    expect(eventFor({ kind: "context_compaction_started" })?.type).toBe("coding_context_compaction_started");
    expect(eventFor({ kind: "context_compaction_completed" })?.type).toBe("coding_context_compaction_completed");
  });

  it("carries only the fields the runner reported", () => {
    expect(eventFor({ kind: "context_compaction_completed", trigger: "auto", preTokens: 100, postTokens: 20 })?.payload)
      .toMatchObject({ type: "coding_context_compaction_completed", trigger: "auto", preTokens: 100, postTokens: 20 });

    const sparse = eventFor({ kind: "context_compaction_completed" })?.payload as Record<string, unknown>;
    expect(sparse.trigger).toBeUndefined();
    expect(sparse.preTokens).toBeUndefined();
    expect(sparse.postTokens).toBeUndefined();
    expect(sparse.failed).toBeUndefined();

    expect(eventFor({ kind: "context_compaction_completed", failed: true })?.payload)
      .toMatchObject({ failed: true });
  });

  it("carries the compaction threshold beside the other occupancy fields", () => {
    const payload = codingTokenUsageUpdatedEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "claude_code",
      contextWindowUsedTokens: 12_000,
      modelContextWindowTokens: 200_000,
      contextCompactionThresholdTokens: 160_000
    })?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "coding_token_usage_updated",
      contextWindowUsedTokens: 12_000,
      modelContextWindowTokens: 200_000,
      contextCompactionThresholdTokens: 160_000
    });

    // A runner that reports no threshold leaves the field off the wire rather
    // than sending a zero or a share of the window.
    const withoutThreshold = codingTokenUsageUpdatedEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "codex",
      contextWindowUsedTokens: 12_000
    })?.payload as Record<string, unknown>;
    expect(withoutThreshold.contextCompactionThresholdTokens).toBeUndefined();

    const clearedThreshold = codingTokenUsageUpdatedEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-2",
      runnerKind: "claude_code",
      contextCompactionThresholdTokens: null
    })?.payload as Record<string, unknown>;
    expect(clearedThreshold).toHaveProperty("contextCompactionThresholdTokens", null);
  });

  it("produces no event without a turn to attribute the compaction to", () => {
    // A compaction happens inside a turn; without one there is nothing to
    // attribute it to, the same rule every other non-session kind follows.
    const event = codingEventFromRunnerActivity({
      sessionId: "agent-session-1",
      runnerKind: "acp_demo",
      activity: { kind: "acp_session_update", title: "Agent update", content: {}, canonical: { kind: "context_compaction_started" } }
    });
    expect(event).toBeUndefined();
  });
});
