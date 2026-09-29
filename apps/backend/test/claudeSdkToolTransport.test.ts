import { afterEach, describe, expect, it } from "vitest";
import { registerAgentTool, unregisterAgentTool } from "../src/agentTools/catalog";
import "../src/agentTools/questionAsk";
import { advertisedAgentTools } from "../src/agentTools/dispatch";
import { prepareAgentRunnerToolSet } from "../src/agentTools/runnerToolSet";
import { ClaudeSessionTools, agentRoomServerConnected, claudeAllowedToolNames } from "../src/runner/claudeCode/agentTools";
import type { ClaudeCodeMcpServerFactory, ClaudeCodeQuery } from "../src/runner/claudeCode/sdk";

/**
 * The Claude Code AgentRoom tool server (`runner/claudeCode/agentTools.ts`),
 * run against the installed `@anthropic-ai/claude-agent-sdk` 0.3.283
 * in-process MCP server with no claude child, model, or plan storage. First
 * proven as a Stage 1 fixture in docs/plans/AGENT_PLAN_TOOLS_PLAN.md; the
 * shared conformance suite drives the whole adapter.
 *
 * The bundled CLI (2.1.283) stamps each MCP `tools/call` with
 * `_meta["claudecode/toolUseId"]`, the id carried by the assistant `tool_use`
 * block on the SDK message stream: that id, not whichever turn is current,
 * identifies the originating turn.
 */

const TOOL_USE_META = "claudecode/toolUseId";

const loadFactory = async (): Promise<ClaudeCodeMcpServerFactory> =>
  (await import("@anthropic-ai/claude-agent-sdk")).createSdkMcpServer as unknown as ClaudeCodeMcpServerFactory;

/** The assistant message that announces one tool use on the stream. */
const toolUseMessage = (id: string, name = "transport_probe") => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__agentroom__${name}`, input: {} }] }
});

async function connect(tools: ClaudeSessionTools) {
  const server = tools.queryOptions().mcpServers.agentroom as ReturnType<ClaudeCodeMcpServerFactory>;
  const sent: Array<Record<string, any>> = [];
  const transport: Record<string, any> = {
    start: async () => undefined,
    close: async () => undefined,
    send: async (message: Record<string, any>) => { sent.push(message); }
  };
  await server.instance.connect(transport);
  const reply = async (id: number) => {
    for (let spins = 0; spins < 600; spins += 1) {
      const found = sent.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No reply to ${id}`);
  };
  let nextId = 1_000;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    transport.onmessage({ jsonrpc: "2.0", id, method, params });
    return reply(id);
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    request,
    reply,
    startCall: (id: number, params: Record<string, unknown>) => transport.onmessage({ jsonrpc: "2.0", id, method: "tools/call", params }),
    notify: (method: string, params: Record<string, unknown>) => transport.onmessage({ jsonrpc: "2.0", method, params })
  };
}

const probeLogicalId = "test.transport_probe";
const probeUnavailable = "The probe could not run. No successful call was confirmed.";

function registerProbe(): void {
  registerAgentTool({
    logicalId: probeLogicalId,
    name: "transport_probe",
    description: "A second AgentRoom tool beside questions.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    outputSchema: { type: "string", maxLength: 40 * 1024 },
    unavailableResult: probeUnavailable,
    requiredCapability: "questions"
  });
}

afterEach(() => unregisterAgentTool(probeLogicalId));

function probeTurn(runId: string, calls: Array<{ runId: string; input: unknown }>, wait?: (signal: AbortSignal) => Promise<void>) {
  return prepareAgentRunnerToolSet({
    runId,
    sessionKey: "session-1",
    catalog: [probeLogicalId],
    allowed: [probeLogicalId],
    required: true,
    handlers: {
      [probeLogicalId]: async (input, context) => {
        calls.push({ runId: context.runId, input });
        await wait?.(context.signal);
        return JSON.stringify({ echoed: input });
      }
    },
    isLive: () => true
  });
}

const textOf = (reply: Record<string, any>): string => reply.result.content[0].text;

async function sessionTools(): Promise<ClaudeSessionTools> {
  registerProbe();
  return new ClaudeSessionTools(await loadFactory(), advertisedAgentTools(["questions.ask", probeLogicalId]));
}

describe("Claude Code AgentRoom tool server (SDK 0.3.283, CLI 2.1.283)", () => {
  it("advertises the shared catalog verbatim and pre-approves exactly its names", async () => {
    const tools = await sessionTools();
    const fixture = await connect(tools);
    const catalog = advertisedAgentTools(["questions.ask", probeLogicalId]);
    const listed = await fixture.request("tools/list", {});
    expect(listed.result.tools).toEqual(catalog.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema
    })));
    expect(tools.queryOptions().allowedTools).toEqual(claudeAllowedToolNames(["ask_user_question", "transport_probe"]));
    expect(claudeAllowedToolNames(["transport_probe"])).toEqual(["mcp__agentroom__transport_probe"]);
    expect(tools.allows("mcp__agentroom__transport_probe")).toBe(true);
    expect(tools.allows("mcp__agentroom__*")).toBe(false);
    expect(tools.allows("Bash")).toBe(false);
  });

  it("passes raw arguments to the originating turn, even when the call outruns its stream message", async () => {
    const tools = await sessionTools();
    const calls: Array<{ runId: string; input: unknown }> = [];
    tools.bindTurn("run-a", probeTurn("run-a", calls).tools.binding);
    const fixture = await connect(tools);

    fixture.startCall(10, {
      name: "transport_probe",
      arguments: { value: "hi", unexpected: true },
      _meta: { [TOOL_USE_META]: "toolu_a1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    tools.observe(toolUseMessage("toolu_a1"), "run-a");
    const reply = await fixture.reply(10);
    expect(JSON.parse(textOf(reply))).toEqual({ echoed: { value: "hi", unexpected: true } });
    expect(calls).toEqual([{ runId: "run-a", input: { value: "hi", unexpected: true } }]);
  });

  it("refuses a delayed call from a released turn after the next turn is bound", async () => {
    const tools = await sessionTools();
    const firstCalls: Array<{ runId: string; input: unknown }> = [];
    const secondCalls: Array<{ runId: string; input: unknown }> = [];
    const first = probeTurn("run-a", firstCalls);
    tools.bindTurn("run-a", first.tools.binding);
    tools.observe(toolUseMessage("toolu_a1"), "run-a");
    first.dispose();
    tools.releaseTurn("run-a");
    tools.bindTurn("run-b", probeTurn("run-b", secondCalls).tools.binding);
    const fixture = await connect(tools);

    const late = await fixture.request("tools/call", {
      name: "transport_probe",
      arguments: { value: "late" },
      _meta: { [TOOL_USE_META]: "toolu_a1" }
    });
    expect(textOf(late)).toBe(probeUnavailable);
    expect(firstCalls).toEqual([]);
    expect(secondCalls).toEqual([]);
  });

  it("fails closed without a tool-use id or when the id never appears on the stream", async () => {
    const tools = await sessionTools();
    const calls: Array<{ runId: string; input: unknown }> = [];
    tools.bindTurn("run-a", probeTurn("run-a", calls).tools.binding);
    const fixture = await connect(tools);

    const missing = await fixture.request("tools/call", { name: "transport_probe", arguments: { value: "x" } });
    const unseen = await fixture.request("tools/call", {
      name: "transport_probe",
      arguments: { value: "x" },
      _meta: { [TOOL_USE_META]: "toolu_never" }
    });
    expect(textOf(missing)).toBe(probeUnavailable);
    expect(textOf(unseen)).toBe(probeUnavailable);
    expect(calls).toEqual([]);
  });

  it("propagates an MCP cancellation into the bound call's signal", async () => {
    const tools = await sessionTools();
    const calls: Array<{ runId: string; input: unknown }> = [];
    let observedAbort = false;
    tools.bindTurn("run-a", probeTurn("run-a", calls, (signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
    })).tools.binding);
    tools.observe(toolUseMessage("toolu_a1"), "run-a");
    const fixture = await connect(tools);

    fixture.startCall(20, { name: "transport_probe", arguments: { value: "x" }, _meta: { [TOOL_USE_META]: "toolu_a1" } });
    for (let spins = 0; spins < 100 && calls.length === 0; spins += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fixture.notify("notifications/cancelled", { requestId: 20, reason: "interrupted" });
    for (let spins = 0; spins < 100 && !observedAbort; spins += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toHaveLength(1);
    expect(observedAbort).toBe(true);
  });

  it("waits for a fresh child to list the server before confirming or refusing it", async () => {
    const querying = (...answers: unknown[][]): ClaudeCodeQuery => {
      let index = 0;
      return { mcpServerStatus: async () => answers[Math.min(index++, answers.length - 1)]! } as unknown as ClaudeCodeQuery;
    };
    // CLI 2.1.283 lists nothing until the child initialized, then `agentroom`
    // with source `sdk` (observed live).
    await expect(agentRoomServerConnected(querying([], [{ name: "agentroom", status: "pending" }], [{ name: "agentroom", status: "connected", source: "sdk" }])))
      .resolves.toBe(true);
    await expect(agentRoomServerConnected(querying([{ name: "agentroom", status: "failed" }]))).resolves.toBe(false);
    await expect(agentRoomServerConnected({} as ClaudeCodeQuery)).resolves.toBeUndefined();
  });
});
