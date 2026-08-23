import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-coding-events-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    codexRunnerProtocol: "jsonrpc",
    ...overrides
  };
};

describe("canonical coding-agent events", () => {
  it("streams normalized Codex JSON-RPC activity beside legacy turn events", async () => {
    const fakeServer = await writeFakeCodexAppServer();
    const serviceConfig = await config({ codexArgs: [fakeServer] });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-coding-workspace-"));
    await mkdir(join(selectedDirectory, ".git"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, title: "Codex native" }
    });

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "render native codex events" }
    });

    expect(turn.statusCode).toBe(202);
    await waitForEvent(app, "coding_turn_completed");

    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    const events = logs.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    const toolActivityTitles = events
      .filter((event) => event.type.startsWith("coding_tool_activity_"))
      .map((event) => (event.payload.activity as { title: string }).title);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent_turn_update",
        payload: expect.objectContaining({
          sessionId: session.json().session.id,
          turnId: turn.json().turn.id,
          message: "Native Codex"
        })
      }),
      expect.objectContaining({
        type: "coding_session_started",
        payload: expect.objectContaining({
          version: 1,
          sessionId: session.json().session.id,
          runnerKind: "codex",
          codex: expect.objectContaining({
            method: "thread/started",
            threadId: "codex-thread-native"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_turn_started",
        payload: expect.objectContaining({
          version: 1,
          sessionId: session.json().session.id,
          turnId: turn.json().turn.id,
          runnerKind: "codex",
          codex: expect.objectContaining({
            method: "turn/started",
            threadId: "codex-thread-native",
            turnId: "codex-turn-native"
          })
        })
      }),
      expect.objectContaining({
        type: "agent_turn_token_usage_updated",
        payload: expect.objectContaining({
          sessionId: session.json().session.id,
          turnId: turn.json().turn.id,
          inputTokens: 14,
          outputTokens: 6,
          totalTokens: 20,
          cachedInputTokens: 4,
          reasoningOutputTokens: 2,
          modelContextWindowTokens: 258400
        })
      }),
      expect.objectContaining({
        type: "coding_token_usage_updated",
        payload: expect.objectContaining({
          version: 1,
          sessionId: session.json().session.id,
          turnId: turn.json().turn.id,
          inputTokens: 14,
          outputTokens: 6,
          totalTokens: 20,
          cachedInputTokens: 4,
          reasoningOutputTokens: 2,
          contextWindowUsedTokens: 12,
          modelContextWindowTokens: 258400,
          codex: expect.objectContaining({
            method: "thread/tokenUsage/updated",
            threadId: "codex-thread-native",
            turnId: "codex-turn-native"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_assistant_message_delta",
        payload: expect.objectContaining({
          version: 1,
          sessionId: session.json().session.id,
          turnId: turn.json().turn.id,
          delta: "Native Codex",
          codex: expect.objectContaining({
            method: "item/agentMessage/delta",
            itemId: "assistant-message-native"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_plan_updated",
        payload: expect.objectContaining({
          plan: [{ step: "Map Codex events", status: "completed" }],
          explanation: "Native renderer plan"
        })
      }),
      expect.objectContaining({
        type: "coding_diff_updated",
        payload: expect.objectContaining({
          summary: "1 file changed",
          files: [{
            path: "apps/backend/src/events/eventTypes.ts",
            status: "modified",
            additions: 12,
            deletions: 2
          }]
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_started",
        payload: expect.objectContaining({
          activity: expect.objectContaining({
            kind: "codex_item_started",
            title: "Run command",
            description: "pnpm test"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_updated",
        payload: expect.objectContaining({
          delta: "pnpm test output"
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_updated",
        payload: expect.objectContaining({
          delta: "Checking the workspace shape",
          activity: expect.objectContaining({
            kind: "codex_reasoning",
            title: "Reasoning update"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_tool_activity_completed",
        payload: expect.objectContaining({
          activity: expect.objectContaining({
            kind: "codex_item_completed",
            title: "Run command",
            description: "pnpm test"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_permission_requested",
        payload: expect.objectContaining({
          request: expect.objectContaining({
            id: "permission-1",
            action: "run_command"
          })
        })
      }),
      expect.objectContaining({
        type: "coding_permission_resolved",
        payload: expect.objectContaining({
          requestId: "permission-1",
          status: "denied"
        })
      })
    ]));
    expect(toolActivityTitles).toEqual(expect.arrayContaining([
      "Run command"
    ]));
    expect(toolActivityTitles).not.toEqual(expect.arrayContaining([
      "Item completed: userMessage",
      "Item completed: reasoning",
      "Item completed: agentMessage"
    ]));
    const firstLegacyDeltaIndex = events.findIndex((event) => event.type === "agent_turn_update");
    const firstCanonicalDeltaIndex = events.findIndex((event) => event.type === "coding_assistant_message_delta");
    expect(firstCanonicalDeltaIndex).toBeGreaterThan(-1);
    expect(firstLegacyDeltaIndex).toBeGreaterThan(-1);
    expect(firstCanonicalDeltaIndex).toBeLessThan(firstLegacyDeltaIndex);

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().sessions[0]).toEqual(expect.objectContaining({
      id: session.json().session.id,
      modelContextWindowTokens: 258400,
      contextWindowUsedTokens: 12
    }));
    expect(status.json().metrics).toMatchObject({
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20
    });

    await app.close();
  });
});

async function writeFakeCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-coding-events-"));
  const path = join(root, "fake-codex-coding-events.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-native",
    status: "running",
    cwd: "/tmp/workspace",
    model: "gpt-test",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-native",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId: "codex-thread-native", turn: turn("inProgress") } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", tokenUsage: { total: { inputTokens: 14, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 20 }, last: { inputTokens: 8, cachedInputTokens: 4, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 12 }, modelContextWindow: 258400 } } });
    send({ method: "turn/plan/updated", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", explanation: "Native renderer plan", plan: [{ step: "Map Codex events", status: "completed" }] } });
    send({ method: "turn/diff/updated", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", summary: "1 file changed", files: [{ path: "apps/backend/src/events/eventTypes.ts", status: "modified", additions: 12, deletions: 2 }] } });
    send({ method: "item/completed", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", item: { id: "user-1", type: "userMessage" } } });
    send({ method: "item/completed", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", item: { id: "reasoning-1", type: "reasoning" } } });
    send({ method: "item/reasoning/delta", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", itemId: "reasoning-1", delta: "Checking the workspace shape" } });
    send({ method: "item/completed", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", item: { id: "assistant-message-native", type: "agentMessage" } } });
    send({ method: "item/started", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", item: { id: "tool-1", type: "commandExecution", command: "pnpm test" } } });
    send({ method: "item/commandExecution/outputDelta", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", itemId: "tool-1", delta: "pnpm test output" } });
    send({ method: "item/completed", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", item: { id: "tool-1", type: "commandExecution", command: "pnpm test" } } });
    send({ method: "permission/requested", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", request: { id: "permission-1", action: "run_command" } } });
    send({ method: "permission/resolved", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", requestId: "permission-1", status: "denied" } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-native", turnId: "codex-turn-native", itemId: "assistant-message-native", delta: "Native Codex" } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-native", turn: turn("completed") } });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

async function waitForEvent(app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> }, type: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/logs" });
    const events = response.json().events as Array<{ type: string }>;
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for event ${type}`);
}
