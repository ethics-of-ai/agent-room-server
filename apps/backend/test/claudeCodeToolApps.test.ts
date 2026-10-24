import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import { logger } from "../src/logging/logger";
import { ClaudeCodeToolApps, toolViews } from "../src/runner/claudeCode/toolApps";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import type { ServiceConfig } from "../src/domain/models";

const SERVER = "claude.ai optima-agents";
const TOOL = "mcp__claude_ai_optima-agents__show_usage_dashboard";
const URI = "ui://optima/dashboard.html";
const HTML = "<!doctype html><html><body>dashboard</body></html>";

// What the CLI reported for the live Optima connector (claude-agent-sdk 0.3.296).
const statuses = [
  { name: "agentroom", status: "connected", tools: [{ name: "plan_update" }] },
  {
    name: SERVER,
    status: "connected",
    tools: [
      { name: "list_sites", annotations: { readOnly: true } },
      { name: "show_usage_dashboard", annotations: { readOnly: true }, _meta: { ui: { resourceUri: URI } } }
    ]
  }
];

// The dashboard tool as the view's `hostContext.toolInfo.tool` gets it.
const DASHBOARD_TOOL = {
  name: "show_usage_dashboard",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: URI } }
};

type FakeQuery = ClaudeCodeQuery & { reads: Array<[string, string]>; statusReads: number };

function fakeQuery(overrides: Partial<ClaudeCodeQuery> = {}): FakeQuery {
  const query: FakeQuery = {
    reads: [],
    statusReads: 0,
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
    async mcpServerStatus() {
      query.statusReads += 1;
      return statuses;
    },
    async readMcpResource(serverName: string, uri: string) {
      query.reads.push([serverName, uri]);
      return {
        contents: [{
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: HTML,
          _meta: { ui: { csp: { connectDomains: [] }, prefersBorder: true } }
        }]
      };
    },
    ...overrides
  };
  return query;
}

const toolUse = (id = "toolu-1", name = TOOL, input: Record<string, unknown> = { start_date: "2026-01-01" }) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }
});

const toolResult = (id = "toolu-1", extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "{\"totalCost\":1}", ...extra }] },
  tool_use_result: {
    content: "{\"totalCost\":1}",
    structuredContent: { totalCost: 1 },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "optima", version: "1" } }
  }
});

describe("toolViews", () => {
  it("maps each CLI tool name to its server, declared view and MCP tool", () => {
    const views = toolViews(statuses);
    expect(views.get(TOOL)).toEqual({
      serverName: SERVER,
      toolName: "show_usage_dashboard",
      resourceUri: URI,
      tool: DASHBOARD_TOOL
    });
    expect(views.get("mcp__agentroom__plan_update")).toBeNull();
  });

  it("reads the deprecated flat resourceUri key", () => {
    const flat = [{ name: "spike", tools: [{ name: "show", _meta: { "ui/resourceUri": "ui://spike/view.html" } }] }];
    expect(toolViews(flat).get("mcp__spike__show")?.resourceUri).toBe("ui://spike/view.html");
  });

  it("lists tools without a ui:// view as having none", () => {
    expect(toolViews(statuses).get("mcp__claude_ai_optima-agents__list_sites")).toBeNull();
    const web = [{ name: "spike", tools: [{ name: "show", _meta: { ui: { resourceUri: "https://example.com" } } }] }];
    expect(toolViews(web).get("mcp__spike__show")).toBeNull();
    expect(toolViews(statuses).has("mcp__unknown__show_usage_dashboard")).toBe(false);
  });
});

describe("ClaudeCodeToolApps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures the view, input and full result of a tool with a UI", async () => {
    const query = fakeQuery();
    const apps = new ClaudeCodeToolApps(query);
    expect(await apps.eventsFor(toolUse())).toEqual([]);
    const events = await apps.eventsFor(toolResult());
    expect(query.reads).toEqual([[SERVER, URI]]);
    expect(events).toEqual([{
      type: "tool_app",
      app: {
        toolId: "toolu-1",
        title: "Show usage dashboard",
        serverName: SERVER,
        toolName: "show_usage_dashboard",
        resourceUri: URI,
        tool: DASHBOARD_TOOL,
        html: HTML,
        resourceMeta: { csp: { connectDomains: [] }, prefersBorder: true },
        toolInput: { start_date: "2026-01-01" },
        toolResult: {
          content: [{ type: "text", text: "{\"totalCost\":1}" }],
          structuredContent: { totalCost: 1 },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "optima", version: "1" } }
        }
      }
    }]);
  });

  it("skips failed calls, unseen calls and tools without a view", async () => {
    const query = fakeQuery();
    const apps = new ClaudeCodeToolApps(query);
    await apps.eventsFor(toolUse());
    expect(await apps.eventsFor(toolResult("toolu-1", { is_error: true }))).toEqual([]);
    expect(await apps.eventsFor(toolResult("toolu-2"))).toEqual([]);
    await apps.eventsFor(toolUse("toolu-3", "mcp__claude_ai_optima-agents__list_sites"));
    expect(await apps.eventsFor(toolResult("toolu-3"))).toEqual([]);
    await apps.eventsFor(toolUse("toolu-4", "Bash"));
    expect(await apps.eventsFor(toolResult("toolu-4"))).toEqual([]);
    expect(query.reads).toEqual([]);
    expect(query.statusReads).toBe(1);
  });

  it("reads the server status again only for a tool the last status did not list", async () => {
    const query = fakeQuery();
    const apps = new ClaudeCodeToolApps(query);
    const call = async (id: string, name: string) => {
      await apps.eventsFor(toolUse(id, name));
      return apps.eventsFor(toolResult(id));
    };
    expect(await call("toolu-1", "mcp__claude_ai_optima-agents__list_sites")).toEqual([]);
    expect(await call("toolu-2", "mcp__claude_ai_optima-agents__list_sites")).toEqual([]);
    expect(await call("toolu-3", TOOL)).toHaveLength(1);
    expect(await call("toolu-4", TOOL)).toHaveLength(1);
    expect(query.statusReads).toBe(1);
    expect(await call("toolu-5", "mcp__claude_ai_optima-agents__added_later")).toEqual([]);
    expect(query.statusReads).toBe(2);
  });

  it("falls back to a plain tool activity when the view cannot be read, and logs why", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const wrongType = new ClaudeCodeToolApps(fakeQuery({
      async readMcpResource() {
        return { contents: [{ uri: URI, mimeType: "text/html", text: HTML }] };
      }
    }));
    await wrongType.eventsFor(toolUse());
    expect(await wrongType.eventsFor(toolResult())).toEqual([]);

    const failing = new ClaudeCodeToolApps(fakeQuery({
      async readMcpResource() {
        throw new Error("MCP server claude.ai optima-agents is not connected");
      }
    }));
    await failing.eventsFor(toolUse());
    expect(await failing.eventsFor(toolResult())).toEqual([]);

    const failingStatus = new ClaudeCodeToolApps(fakeQuery({
      async mcpServerStatus() {
        throw new Error("control request timed out");
      }
    }));
    await failingStatus.eventsFor(toolUse());
    expect(await failingStatus.eventsFor(toolResult())).toEqual([]);

    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { runnerKind: "claudeCode", tool: TOOL, reason: "the resource's MIME type is text/html" },
      {
        runnerKind: "claudeCode",
        tool: TOOL,
        reason: "the resource read failed",
        error: "MCP server claude.ai optima-agents is not connected"
      },
      { runnerKind: "claudeCode", tool: TOOL, reason: "the server status read failed", error: "control request timed out" }
    ]);

    // A CLI without resource reads, and a tool without a view, are normal and not logged.
    warn.mockClear();
    const unsupported = new ClaudeCodeToolApps(fakeQuery({ readMcpResource: undefined }));
    await unsupported.eventsFor(toolUse());
    expect(await unsupported.eventsFor(toolResult())).toEqual([]);
    const plain = new ClaudeCodeToolApps(fakeQuery());
    await plain.eventsFor(toolUse("toolu-1", "mcp__claude_ai_optima-agents__list_sites"));
    expect(await plain.eventsFor(toolResult())).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("decodes a base64 blob resource", async () => {
    const apps = new ClaudeCodeToolApps(fakeQuery({
      async readMcpResource(_serverName: string, uri: string) {
        return { contents: [{ uri, mimeType: "text/html; profile=mcp-app", blob: Buffer.from(HTML).toString("base64") }] };
      }
    }));
    await apps.eventsFor(toolUse());
    const [event] = await apps.eventsFor(toolResult());
    expect(event?.type === "tool_app" && event.app.html).toBe(HTML);
  });
});

class ScriptedQuery implements ClaudeCodeQuery {
  readonly output = new AsyncEventQueue<unknown>();
  private readonly views = fakeQuery();

  constructor(prompt: AsyncIterable<unknown>) {
    void (async () => {
      for await (const _message of prompt) this.scriptTurn();
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {}

  mcpServerStatus = () => this.views.mcpServerStatus!();

  // The read resolves after the turn's result is already queued, so the
  // runner must hold the result until the view lands.
  readMcpResource = async (serverName: string, uri: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.views.readMcpResource!(serverName, uri);
  };

  async return(): Promise<IteratorResult<unknown>> {
    this.output.close();
    return { value: undefined, done: true };
  }

  private scriptTurn(): void {
    const session_id = "claude-session-1";
    this.output.push({ type: "system", subtype: "init", session_id, model: "claude-fable-5", uuid: "uuid-init" });
    this.output.push({ ...toolUse(), session_id, uuid: "uuid-assistant", parent_tool_use_id: null });
    this.output.push({ ...toolResult(), session_id, uuid: "uuid-tool-result", parent_tool_use_id: null });
    this.output.push({ type: "result", subtype: "success", is_error: false, session_id, uuid: "uuid-result", result: "Shown." });
  }
}

describe("ClaudeCodeRunner tool views", () => {
  it("emits the tool view inside the turn that made the call", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-claude-tool-apps-"));
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
    const queryFunction: ClaudeCodeQueryFunction = ({ prompt }) => new ScriptedQuery(prompt);
    const runner = new ClaudeCodeRunner(config, { loadQuery: async () => queryFunction });
    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agentroom-session-1",
      workspacePath: root,
      prompt: "Show the dashboard"
    })) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_app");
    expect(types.indexOf("tool_app")).toBeLessThan(types.indexOf("run_succeeded"));
    await runner.dispose();
  });
});
