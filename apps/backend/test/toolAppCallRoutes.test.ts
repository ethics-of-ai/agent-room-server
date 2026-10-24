import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ArtifactStore } from "../src/artifact/ArtifactStore";
import { ToolAppCallService, MAX_TOOL_APP_CALL_RESULT_BYTES } from "../src/agent/toolAppCalls";
import { EventBus } from "../src/events/EventBus";
import { registerToolAppCallRoutes } from "../src/routes/toolAppCallRoutes";
import type { AgentSession } from "../src/domain/models";
import type { AgentRunner, ToolAppCallResult } from "../src/runner/AgentRunner";
import type { AgentToolAppCalledPayload } from "../src/events/eventTypes";

const SERVER = "claude.ai optima-agents";
const URL = "/api/agent-sessions/session-1/artifacts/turn-1:tool-app-toolu-1/tool-calls";

const session = { id: "session-1", workspaceId: "workspace-1", runnerKind: "claude_code" } as AgentSession;

async function harness(answer: (input: Parameters<NonNullable<AgentRunner["callToolAppTool"]>>[0]) => ToolAppCallResult) {
  const artifacts = new ArtifactStore();
  artifacts.putToolApp({
    sessionId: "session-1",
    turnId: "turn-1",
    artifactId: "turn-1:tool-app-toolu-1",
    title: "Show usage dashboard",
    html: "<p>dashboard</p>",
    toolApp: {
      serverName: SERVER,
      toolName: "show_usage_dashboard",
      resourceUri: "ui://optima/dashboard.html",
      tool: { name: "show_usage_dashboard" },
      toolInput: {},
      toolResult: {},
      supportsToolCalls: true
    },
    at: "2026-10-19T00:00:00Z"
  });
  const calls: Array<Parameters<NonNullable<AgentRunner["callToolAppTool"]>>[0]> = [];
  const runner = {
    async callToolAppTool(input) {
      calls.push(input);
      return answer(input);
    }
  } as Partial<AgentRunner> as AgentRunner;
  const eventBus = new EventBus();
  const app = Fastify();
  await registerToolAppCallRoutes(app, new ToolAppCallService({
    getSession: (id) => (id === session.id ? session : undefined),
    artifacts,
    runners: { claude_code: runner },
    eventBus
  }));
  const events = () => eventBus.getRecentEvents(10)
    .filter((event) => event.type === "agent_tool_app_called")
    .map((event) => event.payload as AgentToolAppCalledPayload);
  return { app, calls, events };
}

describe("POST /api/agent-sessions/:sessionId/artifacts/:artifactId/tool-calls", () => {
  it("calls the tool on the artifact's own server and audits a digest of the arguments", async () => {
    const { app, calls, events } = await harness(() => ({ kind: "called", result: { content: [{ type: "text", text: "ok" }] } }));
    const response = await app.inject({
      method: "POST",
      url: URL,
      payload: { name: "list_sites", arguments: { start_date: "2026-02-01" }, serverName: "somewhere else" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { content: [{ type: "text", text: "ok" }] } });
    expect(calls).toEqual([{
      sessionId: "session-1",
      serverName: SERVER,
      toolName: "list_sites",
      arguments: { start_date: "2026-02-01" }
    }]);
    const [event] = events();
    expect(event).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1", toolName: "list_sites", outcome: "called" });
    expect(event?.audit.argumentsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toContain("2026-02-01");
  });

  it("maps refusals to statuses and audits them", async () => {
    const answers: ToolAppCallResult[] = [
      { kind: "unknown_tool" },
      { kind: "unavailable" },
      { kind: "failed", message: "MCP server not connected" }
    ];
    const { app, events } = await harness(() => answers.shift()!);
    const post = () => app.inject({ method: "POST", url: URL, payload: { name: "list_sites" } });
    expect((await post()).statusCode).toBe(404);
    expect((await post()).statusCode).toBe(409);
    const failed = await post();
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toContain("MCP server not connected");
    expect(events().map((event) => event.outcome)).toEqual(["unknown_tool", "unavailable", "failed"]);
    expect(JSON.stringify(events()), "the broadcast event leaves out the server's error text").not.toContain("not connected");
  });

  it("refuses an oversized result", async () => {
    const big = "x".repeat(MAX_TOOL_APP_CALL_RESULT_BYTES + 1);
    const { app, events } = await harness(() => ({ kind: "called", result: { content: [{ type: "text", text: big }] } }));
    const response = await app.inject({ method: "POST", url: URL, payload: { name: "list_sites" } });
    expect(response.statusCode).toBe(502);
    expect(events().map((event) => event.outcome)).toEqual(["result_too_large"]);
  });

  it("rejects bad input before any call", async () => {
    const { app, calls, events } = await harness(() => ({ kind: "called", result: {} }));
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
    expect((await post(URL, { name: "mcp__x__y y" })).statusCode).toBe(400);
    expect((await post(URL, { name: "list_sites", arguments: ["a"] })).statusCode).toBe(400);
    expect((await post(URL, { name: "list_sites", arguments: { blob: "x".repeat(70 * 1024) } })).statusCode).toBe(413);
    expect((await post("/api/agent-sessions/nope/artifacts/turn-1:tool-app-toolu-1/tool-calls", { name: "a" })).statusCode).toBe(404);
    expect((await post("/api/agent-sessions/session-1/artifacts/missing/tool-calls", { name: "a" })).statusCode).toBe(404);
    expect(calls).toEqual([]);
    expect(events()).toEqual([]);
  });
});
