import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import { ClaudeCodeToolApps, isAppVisible } from "../src/runner/claudeCode/toolApps";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { ServiceConfig } from "../src/domain/models";

const SERVER = "claude.ai optima-agents";
const DASHBOARD = "mcp__claude_ai_optima-agents__show_usage_dashboard";

// The Optima connector as the CLI reports it, plus one tool hidden from apps
// and one only apps may call.
const statuses = [
  { name: "agentroom", status: "connected", tools: [{ name: "plan_update" }] },
  {
    name: SERVER,
    status: "connected",
    tools: [
      { name: "list_sites", annotations: { readOnly: true } },
      { name: "show_usage_dashboard", annotations: { readOnly: true }, _meta: { ui: { resourceUri: "ui://optima/dashboard.html" } } },
      { name: "rotate_keys", _meta: { ui: { visibility: ["model"] } } },
      { name: "refresh_chart", _meta: { ui: { visibility: ["app"] } } },
      { name: "odd_visibility", _meta: { ui: { visibility: "app" } } }
    ]
  }
];

type CallingQuery = ClaudeCodeQuery & { requests: Array<Record<string, unknown>> };

function callingQuery(reply: (request: Record<string, unknown>) => unknown = () => ({
  subtype: "success",
  request_id: "r1",
  response: { content: "{\"totalCost\":2}", structuredContent: { totalCost: 2 } }
})): CallingQuery {
  const query: CallingQuery = {
    requests: [],
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
    async mcpServerStatus() {
      return statuses;
    },
    async request(request: Record<string, unknown>) {
      query.requests.push(request);
      return reply(request);
    }
  };
  return query;
}

describe("isAppVisible", () => {
  it("lets apps call a tool with no visibility or one that lists app", () => {
    expect(isAppVisible(statuses, SERVER, "list_sites")).toBe(true);
    expect(isAppVisible(statuses, SERVER, "refresh_chart")).toBe(true);
  });

  it("refuses a tool hidden from apps, a malformed list, and anything the status does not list", () => {
    expect(isAppVisible(statuses, SERVER, "rotate_keys")).toBe(false);
    expect(isAppVisible(statuses, SERVER, "odd_visibility")).toBe(false);
    expect(isAppVisible(statuses, SERVER, "missing")).toBe(false);
    expect(isAppVisible(statuses, "claude_ai_optima-agents", "list_sites")).toBe(false);
    expect(isAppVisible(statuses, "agentroom", "list_sites")).toBe(false);
  });
});

describe("ClaudeCodeToolApps.callTool", () => {
  it("sends mcp_call under the CLI tool name and returns a CallToolResult", async () => {
    const query = callingQuery();
    const apps = new ClaudeCodeToolApps(query);
    expect(apps.supportsToolCalls).toBe(true);
    const answer = await apps.callTool(SERVER, "show_usage_dashboard", { start_date: "2026-02-01" });
    expect(query.requests).toEqual([{ subtype: "mcp_call", tool: DASHBOARD, arguments: { start_date: "2026-02-01" } }]);
    expect(answer).toEqual({
      kind: "called",
      result: { content: [{ type: "text", text: "{\"totalCost\":2}" }], structuredContent: { totalCost: 2 } }
    });
  });

  it("refuses a tool apps may not call without asking the CLI", async () => {
    const query = callingQuery();
    const apps = new ClaudeCodeToolApps(query);
    expect(await apps.callTool(SERVER, "rotate_keys", {})).toEqual({ kind: "unknown_tool" });
    expect(await apps.callTool("agentroom", "plan_update", {})).toEqual({ kind: "called", result: expect.anything() });
    expect(await apps.callTool("other", "list_sites", {})).toEqual({ kind: "unknown_tool" });
    expect(query.requests.map((request) => request.tool)).toEqual(["mcp__agentroom__plan_update"]);
  });

  it("is unavailable when the SDK has no private request()", async () => {
    const apps = new ClaudeCodeToolApps(callingQuery());
    const withoutRequest = new ClaudeCodeToolApps({ ...callingQuery(), request: undefined });
    expect(apps.supportsToolCalls).toBe(true);
    expect(withoutRequest.supportsToolCalls).toBe(false);
    expect(await withoutRequest.callTool(SERVER, "list_sites", {})).toEqual({ kind: "unavailable" });
  });

  it("reports a refused call as failed with secrets redacted", async () => {
    const apps = new ClaudeCodeToolApps(callingQuery(() => {
      throw new Error("MCP server claude.ai optima-agents requires authentication: token=abc123");
    }));
    const answer = await apps.callTool(SERVER, "list_sites", {});
    expect(answer.kind).toBe("failed");
    expect(answer.kind === "failed" && answer.message).toContain("requires authentication");
    expect(answer.kind === "failed" && answer.message).not.toContain("abc123");
  });
});

class IdleQuery implements ClaudeCodeQuery {
  readonly output = new AsyncEventQueue<unknown>();
  readonly requests: Array<Record<string, unknown>> = [];

  constructor(prompt: AsyncIterable<unknown>) {
    void (async () => {
      for await (const _message of prompt) {
        const session_id = "claude-session-1";
        this.output.push({ type: "system", subtype: "init", session_id, model: "claude-fable-5", uuid: "uuid-init" });
        this.output.push({ type: "result", subtype: "success", is_error: false, session_id, uuid: "uuid-result", result: "Done." });
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {}

  async mcpServerStatus(): Promise<unknown[]> {
    return statuses;
  }

  async request(request: Record<string, unknown>): Promise<unknown> {
    this.requests.push(request);
    return { subtype: "success", response: { content: [{ type: "text", text: "ok" }] } };
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.output.close();
    return { value: undefined, done: true };
  }
}

describe("ClaudeCodeRunner.callToolAppTool", () => {
  it("calls through the session's live child and is unavailable without one", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-claude-tool-calls-"));
    const config: ServiceConfig = {
      runnerKind: "claude_code",
      host: "0.0.0.0",
      port: 8787,
      workspaceRoot: root,
      stateDir: join(root, ".state"),
      requireAuth: false,
      gitCommandTimeoutMs: 30_000,
      codexArgs: []
    };
    let child: IdleQuery | undefined;
    const queryFunction: ClaudeCodeQueryFunction = ({ prompt }) => (child = new IdleQuery(prompt));
    const runner = new ClaudeCodeRunner(config, { loadQuery: async () => queryFunction });
    const call = { serverName: SERVER, toolName: "list_sites", arguments: {} };

    expect(await runner.callToolAppTool({ sessionId: "agentroom-session-1", ...call })).toEqual({ kind: "unavailable" });
    for await (const _event of runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agentroom-session-1",
      workspacePath: root,
      prompt: "Hello"
    })) { /* drain */ }
    expect(await runner.callToolAppTool({ sessionId: "agentroom-session-1", ...call })).toEqual({
      kind: "called",
      result: { content: [{ type: "text", text: "ok" }] }
    });
    expect(child?.requests).toEqual([{ subtype: "mcp_call", tool: "mcp__claude_ai_optima-agents__list_sites", arguments: {} }]);
    expect(await runner.callToolAppTool({ sessionId: "agentroom-session-2", ...call })).toEqual({ kind: "unavailable" });
    await runner.dispose();
  });
});
