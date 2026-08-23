import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerEvent, AgentRunnerInput } from "../src/runner/AgentRunner";
import { codingAgentEventPayloadSchema } from "../src/protocol/coding/events";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-claude-events-"));
  return {
    runnerKind: "claude_code",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

function fakeClaudeCodeRunner(): AgentRunner {
  return {
    async getCapabilities() {
      return {
        runnerKind: "claude_code",
        settings: { models: [], defaultSettings: {} }
      };
    },
    validateInputParts() {},
    async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
      const runner = { nativeSessionId: "claude-session-e2e" };
      yield {
        type: "runner_audit",
        audit: {
          phase: "started",
          runnerKind: "claude_code",
          runId: input.runId,
          command: { executableName: "claude", argsCount: 0 }
        }
      };
      yield {
        type: "agent_activity",
        activity: {
          kind: "claude_code_session_started",
          title: "Session started",
          content: {
            session_id: "claude-session-e2e",
            model: "claude-fable-5",
            cwd: input.workspacePath,
            permissionMode: "bypassPermissions"
          },
          canonical: { kind: "session_started" },
          runner: {
            ...runner,
            model: "claude-fable-5",
            cwd: input.workspacePath,
            posture: { label: "permissionMode", value: "bypassPermissions" }
          }
        }
      };
      yield {
        type: "agent_activity",
        activity: {
          kind: "claude_code_turn_started",
          title: "Turn started",
          content: { session_id: "claude-session-e2e" },
          canonical: { kind: "turn_started" },
          runner
        }
      };
      yield { type: "agent_update", message: "Native Claude", runner };
      yield {
        type: "agent_activity",
        activity: {
          kind: "claude_code_reasoning",
          title: "Reasoning update",
          content: { delta: "thinking about the repo" },
          canonical: { kind: "reasoning", delta: "thinking about the repo" },
          runner
        }
      };
      yield {
        type: "agent_activity",
        activity: {
          kind: "claude_code_tool_started",
          title: "Run command",
          description: "ls",
          content: { toolUseId: "tool-1", name: "Bash", input: { command: "ls" } },
          canonical: { kind: "tool_started", toolId: "tool-1" },
          runner: { ...runner, nativeItemId: "tool-1" }
        }
      };
      yield {
        type: "agent_activity",
        activity: {
          kind: "claude_code_tool_completed",
          title: "Run command",
          content: { toolUseId: "tool-1", isError: false },
          canonical: { kind: "tool_completed", toolId: "tool-1" },
          runner: { ...runner, nativeItemId: "tool-1" }
        }
      };
      yield {
        type: "token_usage_updated",
        runner,
        inputTokens: 16,
        cachedInputTokens: 4,
        outputTokens: 6,
        totalTokens: 22,
        contextWindowUsedTokens: 18,
        modelContextWindowTokens: 200_000
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {}
  };
}

describe("claude code canonical coding events", () => {
  it("streams claude_code runner activity as coding_* events with bounded claudeCode metadata", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-claude-workspace-"));
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: fakeClaudeCodeRunner() }
    });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "claude_code", title: "Claude native" }
    });

    expect(session.statusCode).toBe(201);
    expect(session.json().session.runnerKind).toBe("claude_code");

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "render native claude events" }
    });
    expect(turn.statusCode).toBe(202);
    await waitForEvent(app, "coding_turn_completed");

    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    const events = logs.json().events as Array<{ type: string; payload: Record<string, unknown> }>;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "coding_session_started",
        payload: expect.objectContaining({
          runnerKind: "claude_code",
          claudeCode: expect.objectContaining({
            sessionId: "claude-session-e2e",
            model: "claude-fable-5",
            permissionMode: "bypassPermissions"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_turn_started",
        payload: expect.objectContaining({
          runnerKind: "claude_code",
          turnId: turn.json().turn.id
        })
      }),
      expect.objectContaining({
        type: "coding_assistant_message_delta",
        payload: expect.objectContaining({
          delta: "Native Claude",
          claudeCode: expect.objectContaining({ sessionId: "claude-session-e2e" })
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_updated",
        payload: expect.objectContaining({
          delta: "thinking about the repo",
          activity: expect.objectContaining({ kind: "claude_code_reasoning" })
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_started",
        payload: expect.objectContaining({
          activity: expect.objectContaining({ title: "Run command", description: "ls" })
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_completed",
        payload: expect.objectContaining({
          activity: expect.objectContaining({ kind: "claude_code_tool_completed" })
        })
      }),
      expect.objectContaining({
        type: "coding_token_usage_updated",
        payload: expect.objectContaining({
          inputTokens: 16,
          cachedInputTokens: 4,
          outputTokens: 6,
          totalTokens: 22,
          contextWindowUsedTokens: 18,
          modelContextWindowTokens: 200_000
        })
      }),
      expect.objectContaining({ type: "coding_turn_completed" })
    ]));

    const sessionAfter = await app.inject({ method: "GET", url: `/api/agent-sessions/${session.json().session.id}` });
    expect(sessionAfter.json().session).toMatchObject({
      claudeCode: {
        sessionId: "claude-session-e2e",
        model: "claude-fable-5",
        permissionMode: "bypassPermissions"
      },
      modelContextWindowTokens: 200_000,
      contextWindowUsedTokens: 18
    });

    await app.close();
  });

  it("accepts claude_code payloads through the canonical event schema", () => {
    const parsed = codingAgentEventPayloadSchema.safeParse({
      version: 1,
      type: "coding_assistant_message_delta",
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: "claude_code",
      delta: "hello",
      claudeCode: { sessionId: "claude-session-1", messageUuid: "uuid-1" }
    });
    expect(parsed.success).toBe(true);
  });

  it("serves per-runner capabilities and rejects unknown runner kinds", async () => {
    const serviceConfig = await config({ runnerKind: "codex" });
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: fakeClaudeCodeRunner() }
    });

    const claude = await app.inject({ method: "GET", url: "/api/coding-agent/capabilities?runnerKind=claude_code" });
    expect(claude.statusCode).toBe(200);
    expect(claude.json().runnerKind).toBe("claude_code");

    const invalid = await app.inject({ method: "GET", url: "/api/coding-agent/capabilities?runnerKind=unknown" });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });
});

async function waitForEvent(
  app: Awaited<ReturnType<typeof buildServer>>["app"],
  type: string,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    const events = logs.json().events as Array<{ type: string }>;
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for event ${type}`);
}
