import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { AgentRunnerInputError } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-claude-runner-"));
  return {
    runnerKind: "claude_code",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

class FakeClaudeQuery implements ClaudeCodeQuery {
  readonly output = new AsyncEventQueue<unknown>();
  readonly receivedUserMessages: Array<Record<string, unknown>> = [];
  readonly setModelCalls: Array<string | undefined> = [];
  readonly flagSettingsCalls: Array<Record<string, unknown>> = [];
  interruptCalls = 0;
  returned = false;

  constructor(
    prompt: AsyncIterable<unknown>,
    readonly options: Record<string, unknown>,
    private readonly onUserMessage?: (message: Record<string, unknown>, query: FakeClaudeQuery) => void
  ) {
    void (async () => {
      for await (const message of prompt) {
        const object = message as Record<string, unknown>;
        this.receivedUserMessages.push(object);
        this.onUserMessage?.(object, this);
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model);
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flagSettingsCalls.push(settings);
  }

  async supportedModels(): Promise<unknown[]> {
    return [];
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.returned = true;
    this.output.close();
    return { value: undefined, done: true };
  }
}

function fakeQueryHarness(onUserMessage?: (message: Record<string, unknown>, query: FakeClaudeQuery) => void): {
  loadQuery: () => Promise<ClaudeCodeQueryFunction>;
  queries: FakeClaudeQuery[];
} {
  const queries: FakeClaudeQuery[] = [];
  const queryFunction: ClaudeCodeQueryFunction = ({ prompt, options }) => {
    const query = new FakeClaudeQuery(prompt, options, onUserMessage);
    queries.push(query);
    return query;
  };
  return { loadQuery: async () => queryFunction, queries };
}

function scriptedTurn(message: Record<string, unknown>, query: FakeClaudeQuery): void {
  const sessionId = "claude-session-1";
  query.output.push({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-fable-5",
    cwd: "/tmp/workspace",
    permissionMode: "bypassPermissions",
    uuid: "uuid-init"
  });
  query.output.push({
    type: "stream_event",
    session_id: sessionId,
    uuid: "uuid-delta-1",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }
  });
  query.output.push({
    type: "stream_event",
    session_id: sessionId,
    uuid: "uuid-delta-2",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "pondering the workspace" } }
  });
  query.output.push({
    type: "assistant",
    session_id: sessionId,
    uuid: "uuid-assistant-1",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }],
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 9,
        output_tokens: 2
      }
    }
  });
  query.output.push({
    type: "user",
    session_id: sessionId,
    uuid: "uuid-tool-result-1",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }]
    }
  });
  query.output.push({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    uuid: "uuid-result-1",
    result: "Listed the workspace files.",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 4,
      output_tokens: 6
    },
    modelUsage: {
      "claude-fable-5": { contextWindow: 200_000 }
    }
  });
}

describe("ClaudeCodeRunner", () => {
  it("maps a scripted Claude Code SDK turn into runner events", async () => {
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "should-be-scrubbed";
    try {
      const serviceConfig = await config();
      const harness = fakeQueryHarness(scriptedTurn);
      const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
      const events: AgentRunnerEvent[] = [];

      for await (const event of runner.run({
        runId: "agentroom-turn-1",
        sessionId: "agentroom-session-1",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "List the workspace"
      })) {
        events.push(event);
      }

      expect(events[0]).toEqual({
        type: "runner_audit",
        audit: expect.objectContaining({
          phase: "started",
          runnerKind: "claude_code",
          runId: "agentroom-turn-1",
          command: { executableName: "claude", argsCount: 0 }
        })
      });
      expect(events).toContainEqual({
        type: "agent_activity",
        activity: expect.objectContaining({
          kind: "claude_code_session_started",
          canonical: { kind: "session_started" },
          runner: expect.objectContaining({ nativeSessionId: "claude-session-1" })
        })
      });
      expect(events).toContainEqual({
        type: "agent_activity",
        activity: expect.objectContaining({ kind: "claude_code_turn_started" })
      });
      expect(events).toContainEqual({
        type: "agent_update",
        message: "Hello ",
        runner: expect.objectContaining({ nativeSessionId: "claude-session-1" })
      });
      expect(events).toContainEqual({
        type: "agent_activity",
        activity: expect.objectContaining({
          kind: "claude_code_reasoning",
          content: { delta: "pondering the workspace" }
        })
      });
      expect(events).toContainEqual({
        type: "agent_activity",
        activity: expect.objectContaining({
          kind: "claude_code_tool_started",
          title: "Run command",
          description: "ls -la"
        })
      });
      expect(events).toContainEqual({
        type: "agent_activity",
        activity: expect.objectContaining({
          kind: "claude_code_tool_completed",
          title: "Run command"
        })
      });
      // Live occupancy comes from the assistant message's per-request usage
      // (3 + 1 + 9 + 2), never the result message's turn-aggregate usage.
      expect(events).toContainEqual({
        type: "token_usage_updated",
        runner: expect.objectContaining({ nativeSessionId: "claude-session-1" }),
        contextWindowUsedTokens: 15
      });
      expect(events).toContainEqual({
        type: "token_usage_updated",
        runner: expect.objectContaining({ nativeSessionId: "claude-session-1" }),
        inputTokens: 16,
        cachedInputTokens: 4,
        outputTokens: 6,
        totalTokens: 22,
        modelContextWindowTokens: 200_000
      });
      expect(events.at(-2)).toEqual({
        type: "runner_audit",
        audit: expect.objectContaining({ phase: "completed", status: "succeeded" })
      });
      expect(events.at(-1)).toEqual({
        type: "run_succeeded",
        message: "Listed the workspace files."
      });

      const options = harness.queries[0].options;
      expect(options.cwd).toBe(serviceConfig.workspaceRoot);
      expect(options.includePartialMessages).toBe(true);
      expect(options.settingSources).toEqual(["project"]);
      expect(options.skills).toBe("all");
      expect(options.permissionMode).toBe("bypassPermissions");
      expect(options.allowDangerouslySkipPermissions).toBe(true);
      expect((options.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBeUndefined();
      expect(harness.queries[0].receivedUserMessages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "List the workspace" }] }
      });

      await runner.dispose();
    } finally {
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });

  it("reuses one SDK session per AgentRoom session and applies turn setting overrides", async () => {
    const serviceConfig = await config({
      claudeCodeModel: "claude-fable-5",
      claudeCodeReasoningEffort: "high"
    });
    const harness = fakeQueryHarness(scriptedTurn);
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });

    const collect = async (runId: string, settings?: { model?: string; reasoningEffort?: "medium" }) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-reuse",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "turn prompt",
        settings
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("turn-1");
    expect(first.at(-1)?.type).toBe("run_succeeded");
    const second = await collect("turn-2", { model: "claude-sonnet-4-6", reasoningEffort: "medium" });
    expect(second.at(-1)?.type).toBe("run_succeeded");

    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0].options.model).toBe("claude-fable-5");
    expect(harness.queries[0].options.effort).toBe("high");
    expect(harness.queries[0].setModelCalls).toEqual(["claude-sonnet-4-6"]);
    expect(harness.queries[0].flagSettingsCalls).toEqual([{ effortLevel: "medium" }]);
    expect(harness.queries[0].receivedUserMessages).toHaveLength(2);

    await runner.dispose();
  });

  it("rejects an unsupported open effort before acquiring a Claude session", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness(scriptedTurn);
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "turn-unsupported-effort",
      sessionId: "agentroom-session-unsupported-effort",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "turn prompt",
      settings: { reasoningEffort: "ultra" }
    })) {
      events.push(event);
    }

    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toContain('does not offer the reasoning effort "ultra"');
    expect(harness.queries).toEqual([]);

    await runner.dispose();
  });

  it("interrupts the active turn on cancel and keeps the session for steering", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    const events: AgentRunnerEvent[] = [];

    const run = (async () => {
      for await (const event of runner.run({
        runId: "turn-cancel",
        sessionId: "agentroom-session-cancel",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "long running turn"
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => (harness.queries[0]?.receivedUserMessages.length ?? 0) > 0);
    await runner.cancel("turn-cancel");
    await run;

    expect(harness.queries[0].interruptCalls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "run_failed", error: "Claude Code turn interrupted" });
    expect(events.at(-2)).toEqual({
      type: "runner_audit",
      audit: expect.objectContaining({ phase: "completed", status: "failed" })
    });
    expect(harness.queries[0].returned).toBe(false);

    await runner.dispose();
  });

  it("fails the active turn when the SDK session ends without a result", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness((message, query) => {
      query.output.close();
    });
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "turn-dead-session",
      sessionId: "agentroom-session-dead",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "doomed turn"
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "run_failed",
      error: "Claude Code session ended unexpectedly"
    });

    await runner.dispose();
  });

  it("routes a stale result from an interrupted turn away from the steering follow-up", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });

    const collect = (runId: string) => (async () => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-stale",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: runId
      })) {
        events.push(event);
      }
      return events;
    })();

    const first = collect("turn-stale-1");
    await waitFor(() => (harness.queries[0]?.receivedUserMessages.length ?? 0) === 1);
    await runner.cancel("turn-stale-1");
    const firstEvents = await first;
    expect(firstEvents.at(-1)).toEqual({ type: "run_failed", error: "Claude Code turn interrupted" });

    const second = collect("turn-stale-2");
    await waitFor(() => (harness.queries[0]?.receivedUserMessages.length ?? 0) === 2);
    // The interrupted first turn's trailing result arrives only now, after the
    // follow-up registered as the active turn. It must not close the new turn.
    harness.queries[0].output.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "claude-session-stale"
    });
    harness.queries[0].output.push({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session-stale",
      result: "Steered."
    });
    const secondEvents = await second;
    expect(secondEvents.at(-1)).toEqual({ type: "run_succeeded", message: "Steered." });

    await runner.dispose();
  });

  it("resumes the recorded SDK session when the claude child died between turns", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness((message, query) => {
      query.output.push({
        type: "system",
        subtype: "init",
        session_id: "claude-session-resume",
        model: "claude-fable-5",
        cwd: "/tmp/workspace",
        permissionMode: "bypassPermissions",
        uuid: "uuid-init"
      });
      query.output.push({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-session-resume",
        uuid: "uuid-result",
        result: "Done."
      });
      // The SDK iterable ending emulates the claude child process dying.
      query.output.close();
    });
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-resume",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "resume turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("turn-resume-1");
    expect(first.at(-1)).toEqual({ type: "run_succeeded", message: "Done." });
    // The session-end cleanup is a pure microtask chain; one macrotask hop
    // guarantees it has settled before the next turn looks up the session.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await collect("turn-resume-2");
    expect(second.at(-1)).toEqual({ type: "run_succeeded", message: "Done." });

    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0].options.resume).toBeUndefined();
    expect(harness.queries[1].options.resume).toBe("claude-session-resume");
    // Resume rebuilds the same settings posture as a fresh session; it must
    // not relax (or widen) the workspace-settings gating.
    expect(harness.queries[1].options.settingSources).toEqual(harness.queries[0].options.settingSources);
    expect(harness.queries[1].options.permissionMode).toBe(harness.queries[0].options.permissionMode);

    await runner.dispose();
  });

  it("resumes a seeded SDK session id on the first spawn of the process", async () => {
    // The durable-session hydration path: the first query for this session in
    // this process carries the id a previous process recorded.
    const serviceConfig = await config();
    const harness = fakeQueryHarness((message, query) => {
      query.output.push({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-session-from-disk",
        uuid: "uuid-result",
        result: "Done."
      });
    });
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    runner.rememberResumableId({
      sessionId: "agentroom-session-seeded",
      nativeSessionId: "claude-session-from-disk",
      interrupted: false
    });

    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "turn-seeded-1",
      sessionId: "agentroom-session-seeded",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "seeded turn"
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "Done." });
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0].options.resume).toBe("claude-session-from-disk");

    await runner.dispose();
  });

  it("idle-reaps a quiet SDK session and resumes it on the next turn", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness(scriptedTurn);
    const runner = new ClaudeCodeRunner(serviceConfig, {
      loadQuery: harness.loadQuery,
      idleSessionTimeoutMs: 100
    });

    const collect = async (runId: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of runner.run({
        runId,
        sessionId: "agentroom-session-idle",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "idle turn"
      })) {
        events.push(event);
      }
      return events;
    };

    const first = await collect("turn-idle-1");
    expect(first.at(-1)?.type).toBe("run_succeeded");

    // Past the idle window the child must be reaped...
    await waitFor(() => harness.queries[0].returned);

    // ...and the next turn resumes the recorded SDK session in a fresh child.
    const second = await collect("turn-idle-2");
    expect(second.at(-1)?.type).toBe("run_succeeded");
    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[1].options.resume).toBe("claude-session-1");

    await runner.dispose();
  });

  it("destroys the persistent SDK session when the AgentRoom session is closed", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness(scriptedTurn);
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });

    for await (const event of runner.run({
      runId: "turn-close-1",
      sessionId: "agentroom-session-close",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "first turn"
    })) {
      void event;
    }
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0].returned).toBe(false);

    await runner.closeSession("agentroom-session-close");
    expect(harness.queries[0].returned).toBe(true);

    // A later turn for the same AgentRoom session starts a fresh SDK session.
    for await (const event of runner.run({
      runId: "turn-close-2",
      sessionId: "agentroom-session-close",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "after close"
    })) {
      void event;
    }
    expect(harness.queries).toHaveLength(2);
    // The recreated session must keep the same settings posture as the first;
    // a resume path that dropped workspace-settings loading would drift silently.
    expect(harness.queries[1].options.settingSources).toEqual(harness.queries[0].options.settingSources);
    expect(harness.queries[1].options.skills).toBe(harness.queries[0].options.skills);
    // Closing the AgentRoom session forgets the resumable SDK session id: an
    // explicitly deleted thread must never be silently resumed.
    expect(harness.queries[1].options.resume).toBeUndefined();

    await runner.dispose();
  });

  it("caches capability discovery instead of spawning an SDK session per request", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });

    const first = await runner.getCapabilities();
    const second = await runner.getCapabilities();

    expect(second).toEqual(first);
    expect(harness.queries).toHaveLength(1);

    // The discovery probe runs in the backend cwd, not a registered workspace,
    // so it must stay isolated: no project settings, no skills.
    expect(harness.queries[0].options.cwd).toBe(process.cwd());
    expect(harness.queries[0].options.settingSources).toEqual([]);
    expect(harness.queries[0].options.skills).toBeUndefined();

    await runner.dispose();
  });

  it("does not surface subagent stream deltas as top-level assistant text", async () => {
    const serviceConfig = await config();
    const harness = fakeQueryHarness((message, query) => {
      query.output.push({
        type: "stream_event",
        session_id: "claude-session-sub",
        uuid: "uuid-sub-delta",
        parent_tool_use_id: "tool-parent-1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "subagent narration" } }
      });
      // A subagent request runs in its own context window, so its usage must
      // not surface as the top-level session's occupancy.
      query.output.push({
        type: "assistant",
        session_id: "claude-session-sub",
        uuid: "uuid-sub-assistant",
        parent_tool_use_id: "tool-parent-1",
        message: {
          role: "assistant",
          model: "claude-fable-5",
          content: [{ type: "text", text: "subagent reply" }],
          usage: { input_tokens: 100, output_tokens: 50 }
        }
      });
      query.output.push({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-session-sub",
        result: "Done."
      });
    });
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "turn-subagent",
      sessionId: "agentroom-session-subagent",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "delegate work"
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "agent_update")).toBe(false);
    expect(events.some((event) => event.type === "token_usage_updated")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "Done." });

    await runner.dispose();
  });

  it("accepts image input parts that carry a content type", async () => {
    const serviceConfig = await config();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: fakeQueryHarness().loadQuery });

    expect(() => runner.validateInputParts([])).not.toThrow();
    expect(() =>
      runner.validateInputParts([{ type: "localImage", path: "/tmp/image.png", contentType: "image/png" }])
    ).not.toThrow();
    expect(() => runner.validateInputParts([{ type: "localImage", path: "/tmp/image.png" }]))
      .toThrow(AgentRunnerInputError);
  });

  it("inlines image attachments as base64 blocks in the SDK user message", async () => {
    const serviceConfig = await config();
    const imagePath = join(serviceConfig.workspaceRoot, "clipboard.png");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imagePath, imageBytes);

    const harness = fakeQueryHarness(scriptedTurn);
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: harness.loadQuery });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-image",
      sessionId: "agentroom-session-image",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Describe this image",
      inputParts: [{ type: "localImage", path: imagePath, contentType: "image/png" }]
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("run_succeeded");
    const userMessage = harness.queries[0]?.receivedUserMessages[0];
    const content = (userMessage?.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") }
    });

    await runner.dispose();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
