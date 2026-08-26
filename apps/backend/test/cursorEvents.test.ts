import { describe, expect, it } from "vitest";
import type { AgentRunnerEvent, RunnerMetadata } from "../src/runner/AgentRunner";
import {
  createCursorTurnState,
  mapCursorDelta,
  mapCursorMessage
} from "../src/runner/cursor/messageMapper";

const base: RunnerMetadata = { nativeSessionId: "agent-1", model: "composer-2.5" };
const ctx = () => ({ runId: "run-1", base, state: createCursorTurnState() });

const canonicalKinds = (events: AgentRunnerEvent[]): (string | undefined)[] =>
  events.map((event) => (event.type === "agent_activity" ? event.activity.canonical?.kind : event.type));

describe("Cursor message mapper", () => {
  it("maps assistant text to an update and thinking to reasoning", () => {
    const assistant = mapCursorMessage(
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      ctx()
    );
    expect(assistant).toEqual([{ type: "agent_update", message: "Hello", runner: { ...base, nativeTurnId: "run-1" } }]);

    const thinking = mapCursorMessage({ type: "thinking", text: "pondering" }, ctx());
    expect(canonicalKinds(thinking)).toEqual(["reasoning"]);
    // The empty fragment that only carries the duration closes the block silently.
    expect(mapCursorMessage({ type: "thinking", text: "", thinking_duration_ms: 5 }, ctx())).toEqual([]);
  });

  it("does not map assistant tool_use blocks (the discrete tool_call carries them)", () => {
    const events = mapCursorMessage(
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell", input: {} }] } },
      ctx()
    );
    expect(events).toEqual([]);
  });

  it("maps the tool_call lifecycle with its call id", () => {
    const running = mapCursorMessage(
      { type: "tool_call", call_id: "call-9", name: "shell", status: "running", args: { command: "ls" } },
      ctx()
    );
    expect(canonicalKinds(running)).toEqual(["tool_started"]);
    expect(running[0]).toMatchObject({
      activity: { canonical: { kind: "tool_started", toolId: "call-9" }, runner: { nativeItemId: "call-9" } }
    });

    const completed = mapCursorMessage(
      { type: "tool_call", call_id: "call-9", name: "shell", status: "completed", result: "ok" },
      ctx()
    );
    expect(completed[0]).toMatchObject({ activity: { canonical: { kind: "tool_completed", toolId: "call-9" } } });

    const errored = mapCursorMessage(
      { type: "tool_call", call_id: "call-9", name: "shell", status: "error", result: "boom", truncated: { result: true } },
      ctx()
    );
    expect(errored[0]).toMatchObject({ activity: { title: "Tool failed", content: { isError: true } } });
  });

  it("renders updateTodos as a plan alongside the tool call", () => {
    const events = mapCursorMessage(
      {
        type: "tool_call",
        call_id: "call-plan",
        name: "updateTodos",
        status: "running",
        args: { todos: [{ content: "Ship it", status: "in_progress" }] }
      },
      ctx()
    );
    expect(canonicalKinds(events)).toEqual(["tool_started", "plan_updated"]);
    const plan = events[1];
    if (plan.type !== "agent_activity" || plan.activity.canonical?.kind !== "plan_updated") throw new Error("no plan");
    expect(plan.activity.canonical.steps).toEqual([{ step: "Ship it", status: "in_progress" }]);
  });

  it("never renders the clarifying-question custom tool as a generic tool call", () => {
    const events = mapCursorMessage(
      {
        type: "tool_call",
        call_id: "call-q",
        name: "mcp",
        status: "running",
        args: { providerIdentifier: "custom-user-tools", toolName: "ask_user_question", args: {} }
      },
      ctx()
    );
    expect(events).toEqual([]);
  });

  it("accumulates usage and reports this request's occupancy", () => {
    const state = createCursorTurnState();
    const first = mapCursorMessage(
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 } },
      { runId: "run-1", base, state }
    );
    const second = mapCursorMessage(
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
      { runId: "run-1", base, state }
    );
    expect(first[0]).toMatchObject({ type: "token_usage_updated", inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, reasoningOutputTokens: 1, contextWindowUsedTokens: 12 });
    expect(second[0]).toMatchObject({ type: "token_usage_updated", inputTokens: 15, outputTokens: 5, contextWindowUsedTokens: 8 });
  });

  it("gives status, request, task, and user messages no canonical reading", () => {
    for (const message of [
      { type: "status", status: "FINISHED" },
      { type: "request", request_id: "r1" },
      { type: "task", text: "sub-agent" },
      { type: "user", message: { role: "user", content: [] } },
      { type: "system", subtype: "init", agent_id: "agent-1" }
    ]) {
      expect(mapCursorMessage(message, ctx())).toEqual([]);
    }
  });

  it("forwards only the shell-output delta as tool output", () => {
    const shell = mapCursorDelta(
      { type: "shell-output-delta", callId: "call-9", event: { case: "stdout", value: { data: "line 1\n" } } },
      { base }
    );
    expect(shell[0]).toMatchObject({
      activity: { content: { stream: "stdout" }, canonical: { kind: "tool_output", toolId: "call-9", delta: "line 1" } }
    });
    expect(mapCursorDelta({ type: "text-delta", text: "hi" }, { base })).toEqual([]);
  });
});
