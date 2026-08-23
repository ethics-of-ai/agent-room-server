import { describe, expect, it } from "vitest";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import {
  createDeepSeekTurnState,
  mapDeepSeekSessionEvent,
  type DeepSeekMapContext
} from "../src/runner/deepseek/sessionEventMapper";

const context = (): DeepSeekMapContext => ({
  state: createDeepSeekTurnState(),
  runner: { nativeSessionId: "agent-session-1", model: "deepseek-v4-pro" }
});

const event = (type: string, data: unknown, seq = 1) => ({ type, seq, time: 0, data });

const canonicalKinds = (events: AgentRunnerEvent[]): (string | undefined)[] =>
  events.map((entry) => (entry.type === "agent_activity" ? entry.activity.canonical?.kind : undefined));

/**
 * The DeepSeek session log mapped into the canonical activity union.
 *
 * The point of these assertions is not that each name maps to each kind — it is
 * that the *set* of events with a canonical reading stays deliberate. An event
 * this adapter gives no reading produces no `coding_*` event at all, which is
 * how a non-renderable session fact stays out of the stream without the shared
 * mapper in `protocol/coding` knowing what a DeepSeek event is.
 */
describe("DeepSeek session event mapping", () => {
  it("opens a turn and claims the runtime's turn number", () => {
    const ctx = context();
    const result = mapDeepSeekSessionEvent(event("turn/start", { turn: 7 }), ctx);

    expect(canonicalKinds(result.events)).toEqual(["turn_started"]);
    expect(ctx.state.turnNumber).toBe(7);
    expect(result.events[0]).toMatchObject({
      type: "agent_activity",
      activity: { runner: { nativeTurnId: "7", nativeSessionId: "agent-session-1" } }
    });
  });

  it("streams assistant text as an update the artifact parser can see", () => {
    // `agent_update` is what AgentTurnEventApplier runs the in-band <artifact>
    // parser over, so the live-sketch channel works for this runner without the
    // adapter knowing the channel exists.
    const result = mapDeepSeekSessionEvent(
      event("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Hello" } }),
      context()
    );

    expect(result.events).toEqual([
      expect.objectContaining({ type: "agent_update", message: "Hello" })
    ]);
  });

  it("maps reasoning deltas to the canonical reasoning kind", () => {
    const result = mapDeepSeekSessionEvent(
      event("assistant/chunk", { chunk: { type: "reasoning-delta", index: 0, text: "thinking" } }),
      context()
    );

    expect(result.events[0]).toMatchObject({
      type: "agent_activity",
      activity: { canonical: { kind: "reasoning", delta: "thinking" } }
    });
  });

  it("correlates a tool call with its result through the runtime's own call id", () => {
    const ctx = context();
    const started = mapDeepSeekSessionEvent(
      event("tool/call", { turn: 1, step: 1, callId: "call-9", name: "bash", arguments: "{\"command\":\"ls\"}" }),
      ctx
    );
    const completed = mapDeepSeekSessionEvent(
      event("tool/result", {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "call-9" },
          content: [{ type: "tool-result", toolCallId: "call-9", content: [{ type: "text", text: "README.md" }] }]
        }
      }, 2),
      ctx
    );

    expect(started.events[0]).toMatchObject({
      type: "agent_activity",
      activity: {
        canonical: { kind: "tool_started", toolId: "call-9" },
        runner: { nativeItemId: "call-9" }
      }
    });
    expect(completed.events[0]).toMatchObject({
      type: "agent_activity",
      activity: { canonical: { kind: "tool_completed", toolId: "call-9" } }
    });
  });

  it("carries a failed tool's identity without inventing a canonical failure kind", () => {
    const result = mapDeepSeekSessionEvent(
      event("tool/result", {
        message: { source: { kind: "tool", callId: "call-1" } },
        error: { name: "ToolError", code: "ENOENT" }
      }),
      context()
    );

    expect(result.events[0]).toMatchObject({
      type: "agent_activity",
      activity: { title: "Tool failed", canonical: { kind: "tool_completed", toolId: "call-1" } }
    });
  });

  it("falls back to a tool-result content block when the source has no call id", () => {
    const result = mapDeepSeekSessionEvent(
      event("tool/result", {
        message: {
          content: [{ type: "tool-result", toolCallId: "call-from-block", content: [] }]
        }
      }),
      context()
    );

    expect(result.events[0]).toMatchObject({
      type: "agent_activity",
      activity: { canonical: { kind: "tool_completed", toolId: "call-from-block" } }
    });
  });

  it("maps the todo snapshot to a plan", () => {
    const result = mapDeepSeekSessionEvent(
      event("todo/write", {
        todos: [
          { content: "Read the config", status: "completed" },
          { content: "Fix the bug", status: "in_progress" }
        ]
      }),
      context()
    );

    expect(result.events[0]).toMatchObject({
      type: "agent_activity",
      activity: {
        canonical: {
          kind: "plan_updated",
          steps: [
            { step: "Read the config", status: "completed" },
            { step: "Fix the bug", status: "in_progress" }
          ]
        }
      }
    });
  });

  it("accumulates token totals but reports occupancy from the latest request alone", () => {
    // The cumulative figures re-count the cached conversation on every tool
    // round-trip, so using them as occupancy would overstate it by roughly the
    // number of requests in the turn.
    const ctx = context();
    mapDeepSeekSessionEvent(event("request/context", { provider: "deepseek-official", contextWindow: 128_000 }), ctx);
    expect(mapDeepSeekSessionEvent(
      event("assistant/chunk", { chunk: { type: "usage", usage: { inputTokens: 1_000, outputTokens: 100 } } }),
      ctx
    ).events).toEqual([]);
    mapDeepSeekSessionEvent(
      event("assistant/message", { turn: 1, step: 1, message: {}, usage: { inputTokens: 1_000, outputTokens: 100 } }),
      ctx
    );
    expect(mapDeepSeekSessionEvent(
      event("assistant/chunk", {
        chunk: { type: "usage", usage: { inputTokens: 1_500, outputTokens: 50, cacheReadTokens: 900, reasoningTokens: 20 } }
      }),
      ctx
    ).events).toEqual([]);
    const second = mapDeepSeekSessionEvent(
      event("assistant/message", {
        turn: 1,
        step: 2,
        message: {},
        usage: { inputTokens: 1_500, outputTokens: 50, cacheReadTokens: 900, reasoningTokens: 20 }
      }),
      ctx
    );

    expect(second.events[0]).toEqual({
      type: "token_usage_updated",
      runner: expect.any(Object),
      inputTokens: 2_500,
      cachedInputTokens: 900,
      outputTokens: 150,
      reasoningOutputTokens: 20,
      totalTokens: 2_650,
      contextWindowUsedTokens: 1_550,
      modelContextWindowTokens: 128_000
    });
  });

  it("settles a completed turn and reports a truncated one rather than hiding it", () => {
    expect(mapDeepSeekSessionEvent(event("turn/end", { turn: 1, reason: { kind: "completed" } }), context()).completion)
      .toEqual({ event: { type: "run_succeeded" }, turnNumber: 1 });

    const capped = mapDeepSeekSessionEvent(
      event("turn/end", { turn: 2, reason: { kind: "max-tokens" } }),
      context()
    ).completion;
    expect(capped?.event).toMatchObject({ type: "run_succeeded", message: expect.stringContaining("output-token") });
  });

  it("carries a failed turn's own reason", () => {
    const completion = mapDeepSeekSessionEvent(
      event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "provider refused", code: "BAD" } } }),
      context()
    ).completion;

    expect(completion?.event).toEqual({ type: "run_failed", error: "provider refused" });
  });

  it("settles a turn whose end reason this build does not recognize", () => {
    // A merge-extensible union on a developer-preview runtime: a turn that never
    // settles is a worse failure than one settled under a name we did not know.
    const completion = mapDeepSeekSessionEvent(
      event("turn/end", { turn: 1, reason: { kind: "quarantined-by-a-future-plugin" } }),
      context()
    ).completion;

    expect(completion?.event).toMatchObject({ type: "run_failed", error: expect.stringContaining("quarantined") });
  });

  it("reads the first request header as the only evidence a restore continued the log", () => {
    const resumed = context();
    mapDeepSeekSessionEvent(event("request/header", { reason: "resume" }), resumed);
    expect(resumed.state.resumedLog).toBe(true);

    const fresh = context();
    mapDeepSeekSessionEvent(event("request/header", { reason: "initial" }), fresh);
    // A later `change` header must not overwrite the answer: it says a request
    // used a different header, not that the conversation was found.
    mapDeepSeekSessionEvent(event("request/header", { reason: "change" }, 2), fresh);
    expect(fresh.state.resumedLog).toBe(false);
  });

  it("gives step boundaries, user messages, and unknown types no canonical reading", () => {
    // AgentRoom already holds the transcript, and a plugin may add event types.
    // Neither may produce a `coding_*` event.
    for (const type of ["step/start", "step/end", "user/message", "session/end-seed", "some/future-plugin-event"]) {
      expect(mapDeepSeekSessionEvent(event(type, {}), context()).events).toEqual([]);
    }
  });

  it("skips an event whose payload does not match its type rather than failing the turn", () => {
    expect(mapDeepSeekSessionEvent(event("tool/call", { nonsense: true }), context()).events).toEqual([]);
    expect(mapDeepSeekSessionEvent(event("todo/write", { todos: "not-a-list" }), context()).events).toEqual([]);
  });
});
