import { describe, expect, it } from "vitest";
import {
  boundedRunnerActivity,
  codingAssistantMessageDeltaEvent,
  codingEventFromRunnerActivity,
  runnerSessionMetadataFromActivity
} from "../src/protocol/coding/events";
import type { AgentRunnerActivity, CanonicalActivity, RunnerMetadata } from "../src/runner/AgentRunner";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_OPTIONS
} from "../src/runner/shared/PendingPermissionRequests";

/// Phase 2 of the universal runner boundary: the core mapper dispatches on the
/// adapter-produced canonical payload and never on which runner produced it.
///
/// "acp_demo" here stands in for a third adapter. It is deliberately a runner
/// id no file in `protocol/coding` mentions — if any of these need a change in
/// the mapper to pass, the boundary has leaked again. Session *creation* still
/// rejects an unregistered runner id (that gate is Phase 3's `agentRunnerKind`
/// schema), so this exercises the mapper directly rather than through a turn.
const THIRD_RUNNER = "acp_demo";

function thirdRunnerActivity(
  canonical: CanonicalActivity,
  overrides: Partial<AgentRunnerActivity> = {}
): AgentRunnerActivity {
  return {
    kind: "acp_session_update",
    title: "Agent update",
    content: {},
    canonical,
    runner: { nativeSessionId: "acp-session-1", nativeTurnId: "acp-turn-1" },
    ...overrides
  };
}

function eventFor(canonical: CanonicalActivity, overrides: Partial<AgentRunnerActivity> = {}) {
  return codingEventFromRunnerActivity({
    sessionId: "agent-session-1",
    turnId: "agent-turn-1",
    runnerKind: THIRD_RUNNER,
    activity: thirdRunnerActivity(canonical, overrides)
  });
}

describe("canonical coding-event mapping", () => {
  it("maps every canonical activity kind for a runner the mapper has never heard of", () => {
    const cases: Array<[CanonicalActivity, string]> = [
      [{ kind: "session_started" }, "coding_session_started"],
      [{ kind: "turn_started" }, "coding_turn_started"],
      [{ kind: "plan_updated", steps: [{ step: "read", status: "completed" }] }, "coding_plan_updated"],
      [{ kind: "diff_updated", files: [{ path: "src/app.ts", status: "modified" }] }, "coding_diff_updated"],
      [{ kind: "reasoning", delta: "thinking" }, "coding_tool_activity_updated"],
      [{ kind: "tool_started", toolId: "tool-1" }, "coding_tool_activity_started"],
      [{ kind: "tool_output", toolId: "tool-1", delta: "out" }, "coding_tool_activity_updated"],
      [{ kind: "tool_completed", toolId: "tool-1" }, "coding_tool_activity_completed"],
      [{ kind: "permission_requested", request: { tool: "Bash" } }, "coding_permission_requested"],
      [{ kind: "permission_resolved", requestId: "req-1", status: "denied" }, "coding_permission_resolved"]
    ];

    for (const [canonical, expected] of cases) {
      const event = eventFor(canonical);
      expect(event?.type, `${canonical.kind} should map to ${expected}`).toBe(expected);
      expect(event?.payload.runnerKind).toBe(THIRD_RUNNER);
    }
  });

  it("carries the canonical payload and correlation envelope onto the wire", () => {
    const event = eventFor({ kind: "tool_started", toolId: "tool-1" });
    expect(event?.payload).toMatchObject({
      type: "coding_tool_activity_started",
      runnerKind: THIRD_RUNNER,
      runner: { nativeSessionId: "acp-session-1", nativeTurnId: "acp-turn-1" },
      activity: {
        kind: "acp_session_update",
        canonical: { kind: "tool_started", toolId: "tool-1" },
        runner: { nativeSessionId: "acp-session-1" }
      }
    });
  });

  it("emits no legacy per-runner block for an unknown runner", () => {
    const payload = eventFor({ kind: "reasoning", delta: "thinking" })?.payload as Record<string, unknown>;
    expect(payload.codex).toBeUndefined();
    expect(payload.claudeCode).toBeUndefined();
    expect((payload.activity as Record<string, unknown>).codex).toBeUndefined();
    expect((payload.activity as Record<string, unknown>).claudeCode).toBeUndefined();
  });

  it("produces no coding event for an activity the adapter gave no canonical reading", () => {
    const event = codingEventFromRunnerActivity({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: THIRD_RUNNER,
      activity: { kind: "acp_internal_ping", title: "Ping", content: {} }
    });
    expect(event).toBeUndefined();
  });

  it("still bounds the activity for the legacy agent_turn_activity event", () => {
    const bounded = boundedRunnerActivity(
      thirdRunnerActivity({ kind: "tool_output", toolId: "tool-1", delta: "x".repeat(5_000) }, {
        content: { output: "y".repeat(5_000) }
      }),
      THIRD_RUNNER
    );
    expect((bounded.content.output as string).length).toBe(1_000);
    expect((bounded.canonical as { delta: string }).delta.length).toBe(1_000);
  });

  it("advertises only an exact bounded permission vocabulary", () => {
    const valid = eventFor({
      kind: "permission_requested",
      requestId: "permission-1",
      options: [{ optionId: "x".repeat(MAX_PERMISSION_OPTION_ID_LENGTH), name: "Allow" }],
      request: { title: "Do work" }
    });
    expect(valid?.payload).toMatchObject({
      requestId: "permission-1",
      options: [{ optionId: "x".repeat(MAX_PERMISSION_OPTION_ID_LENGTH), name: "Allow" }]
    });

    const invalidCases: CanonicalActivity[] = [
      {
        kind: "permission_requested",
        requestId: "permission-long",
        options: [{ optionId: "x".repeat(MAX_PERMISSION_OPTION_ID_LENGTH + 1) }],
        request: { title: "Long id" }
      },
      {
        kind: "permission_requested",
        requestId: "permission-many",
        options: Array.from({ length: MAX_PERMISSION_OPTIONS + 1 }, (_, index) => ({ optionId: `option-${index}` })),
        request: { title: "Too many" }
      },
      {
        kind: "permission_requested",
        requestId: "permission-duplicate",
        options: [{ optionId: "same" }, { optionId: "same" }],
        request: { title: "Duplicate" }
      }
    ];

    for (const canonical of invalidCases) {
      const event = eventFor(canonical);
      expect(event?.payload.request).toBeDefined();
      expect(event?.payload.requestId).toBeUndefined();
      expect(event?.payload.options).toBeUndefined();

      const bounded = boundedRunnerActivity(thirdRunnerActivity(canonical), THIRD_RUNNER);
      expect((bounded.canonical as { requestId?: string }).requestId).toBeUndefined();
      expect((bounded.canonical as { options?: unknown[] }).options).toBeUndefined();
    }
  });

  it("records a third runner's session block without knowing its activity kinds", () => {
    const session = runnerSessionMetadataFromActivity(thirdRunnerActivity({ kind: "session_started" }, {
      runner: {
        nativeSessionId: "acp-session-1",
        model: "demo-model",
        cwd: "/tmp/workspace",
        posture: { label: "permissionPolicy", value: "ask" }
      }
    }));
    expect(session).toEqual({
      nativeSessionId: "acp-session-1",
      model: "demo-model",
      cwd: "/tmp/workspace",
      posture: { label: "permissionPolicy", value: "ask" }
    });
  });

  it("reports no session block for any other canonical kind", () => {
    expect(runnerSessionMetadataFromActivity(thirdRunnerActivity({ kind: "turn_started" }))).toBeUndefined();
  });
});

describe("legacy metadata compatibility shim", () => {
  const codexRunner: RunnerMetadata = {
    nativeSessionId: "codex-thread-1",
    nativeTurnId: "codex-turn-1",
    nativeItemId: "item-1",
    model: "gpt-example",
    cwd: "/tmp/workspace",
    posture: { label: "approvalPolicy", value: "never" },
    sandbox: { mode: "workspace-write" },
    native: { method: "item/started" }
  };

  it("rebuilds the codex block from the canonical envelope", () => {
    const event = codingAssistantMessageDeltaEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "codex",
      runner: codexRunner,
      delta: "hello"
    });
    expect(event?.payload).toMatchObject({
      codex: {
        method: "item/started",
        threadId: "codex-thread-1",
        turnId: "codex-turn-1",
        itemId: "item-1",
        model: "gpt-example",
        cwd: "/tmp/workspace",
        approvalPolicy: "never",
        sandbox: { mode: "workspace-write" }
      }
    });
    expect((event?.payload as Record<string, unknown>).claudeCode).toBeUndefined();
  });

  it("rebuilds the claudeCode block from the canonical envelope", () => {
    const event = codingAssistantMessageDeltaEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "claude_code",
      runner: {
        nativeSessionId: "claude-session-1",
        model: "claude-fable-5",
        posture: { label: "permissionMode", value: "bypassPermissions" },
        native: { messageUuid: "uuid-1", parentToolUseId: "parent-1" }
      },
      delta: "hello"
    });
    expect(event?.payload).toMatchObject({
      claudeCode: {
        sessionId: "claude-session-1",
        messageUuid: "uuid-1",
        parentToolUseId: "parent-1",
        model: "claude-fable-5",
        permissionMode: "bypassPermissions"
      }
    });
    expect((event?.payload as Record<string, unknown>).codex).toBeUndefined();
  });

  it("keeps a runner's own posture label out of the other runner's block", () => {
    // A Codex approval policy must never surface as a Claude permission mode:
    // the two postures are deliberately not reconciled into one enum.
    const event = codingAssistantMessageDeltaEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "claude_code",
      runner: { posture: { label: "approvalPolicy", value: "never" } },
      delta: "hello"
    });
    expect((event?.payload as { claudeCode?: { permissionMode?: string } }).claudeCode?.permissionMode)
      .toBeUndefined();
  });

  it("drops an over-limit native blob whole rather than trimming it", () => {
    const event = codingAssistantMessageDeltaEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: THIRD_RUNNER,
      runner: { nativeSessionId: "acp-session-1", native: { method: "x".repeat(2_000) } },
      delta: "hello"
    });
    const runner = (event?.payload as { runner?: Record<string, unknown> }).runner;
    expect(runner?.nativeSessionId).toBe("acp-session-1");
    expect(runner?.native).toBeUndefined();
    expect(runner?.nativeTruncated).toBe(true);
  });

  it("drops a native blob nested deeper than its depth bound", () => {
    const event = codingAssistantMessageDeltaEvent({
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: THIRD_RUNNER,
      runner: { native: { a: { b: { c: { d: "too deep" } } } } },
      delta: "hello"
    });
    const runner = (event?.payload as { runner?: Record<string, unknown> }).runner;
    expect(runner?.native).toBeUndefined();
    expect(runner?.nativeTruncated).toBe(true);
  });
});
