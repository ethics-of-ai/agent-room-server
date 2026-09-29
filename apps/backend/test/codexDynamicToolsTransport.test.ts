import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAgentTool, unregisterAgentTool } from "../src/agentTools/catalog";
import "../src/agentTools/questionAsk";
import { advertisedAgentTools } from "../src/agentTools/dispatch";
import { prepareAgentRunnerToolSet } from "../src/agentTools/runnerToolSet";
import type { AgentRunnerToolSet } from "../src/runner/AgentRunner";
import { codexDynamicToolSpecs, serveCodexDynamicToolCall } from "../src/runner/codex/dynamicTools";
import type { CodexRunnerSession } from "../src/runner/codex/types";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";

/**
 * The Codex dynamic-tool relay (`runner/codex/dynamicTools.ts`) at the call
 * boundary, first proven as a Stage 1 fixture in
 * docs/plans/AGENT_PLAN_TOOLS_PLAN.md. The shared conformance suite drives the
 * whole adapter; this file pins the origin-turn rule with a controlled session
 * record. Wire shapes are from `codex app-server generate-json-schema
 * --experimental` for codex-cli 0.158.0-alpha.2.1; `thread/resume` has no
 * `dynamicTools` field.
 */

const CODEX_DYNAMIC_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

const dynamicToolCallResponseSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(z.object({ type: z.literal("inputText"), text: z.string() }))
}).strict();

/** A session record whose live turn carries the given native id (none yet when undefined) and tools. */
function sessionWith(turnId: string | undefined, tools?: AgentRunnerToolSet): CodexRunnerSession {
  return {
    key: "session-1",
    threadId: "thread-1",
    activeTurn: {
      runId: "run-live", queue: new AsyncEventQueue(), completedByProtocol: false,
      ...(turnId ? { turnId } : {}), ...(tools ? { tools } : {}), toolCalls: new AbortController()
    }
  } as unknown as CodexRunnerSession;
}

const serve = async (session: CodexRunnerSession, params: unknown) =>
  dynamicToolCallResponseSchema.parse(await serveCodexDynamicToolCall(session, params));

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

function probeTurn(runId: string, calls: Array<{ runId: string; input: unknown; callId: string }>, wait?: Promise<void>) {
  return prepareAgentRunnerToolSet({
    runId,
    sessionKey: "session-1",
    catalog: ["questions.ask", probeLogicalId],
    allowed: [probeLogicalId],
    required: true,
    handlers: {
      [probeLogicalId]: async (input, context) => {
        calls.push({ runId: context.runId, input, callId: context.callId });
        await wait;
        return JSON.stringify({ echoed: input });
      }
    },
    isLive: () => true
  });
}

const call = (turnId: string, callId: string, value = "x") => ({
  threadId: "thread-1",
  turnId,
  callId,
  namespace: null,
  tool: "transport_probe",
  arguments: { value }
});

describe("Codex dynamic tool relay (codex-cli 0.158.0-alpha.2.1)", () => {
  it("derives valid, unique dynamic tool specs from the shared catalog without copying schemas", () => {
    registerProbe();
    const catalog = advertisedAgentTools(["questions.ask", probeLogicalId]);
    const specs = codexDynamicToolSpecs(catalog);
    expect(specs.map((spec) => spec.name)).toEqual(["ask_user_question", "transport_probe"]);
    for (const [index, spec] of specs.entries()) {
      expect(spec).toMatchObject({ type: "function", description: catalog[index]!.description });
      expect(spec.name).toMatch(CODEX_DYNAMIC_TOOL_NAME);
      expect(spec.inputSchema).toBe(catalog[index]!.inputSchema);
    }
    expect(new Set(specs.map((spec) => spec.name)).size).toBe(specs.length);
  });

  it("dispatches a call into the live turn its own turn id names", async () => {
    registerProbe();
    const calls: Array<{ runId: string; input: unknown; callId: string }> = [];
    const turn = probeTurn("run-a", calls);
    const response = await serve(sessionWith("codex-turn-a", turn.tools), call("codex-turn-a", "call_1", "hello"));
    expect(response).toEqual({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ echoed: { value: "hello" } }) }] });
    expect(calls).toEqual([{ runId: "run-a", input: { value: "hello" }, callId: "call_1" }]);
  });

  it("answers an in-flight call with the unavailable text once its turn is cancelled", async () => {
    registerProbe();
    let release!: () => void;
    const calls: Array<{ runId: string; input: unknown; callId: string }> = [];
    const turn = probeTurn("run-a", calls, new Promise<void>((resolve) => { release = resolve; }));
    const pending = serve(sessionWith("codex-turn-a", turn.tools), call("codex-turn-a", "call_1"));
    await Promise.resolve();
    turn.dispose();
    release();
    expect((await pending).contentItems[0]!.text).toBe(probeUnavailable);
    expect(calls).toHaveLength(1);
  });

  it("refuses a delayed call from an ended turn once the next turn is live", async () => {
    registerProbe();
    const firstCalls: Array<{ runId: string; input: unknown; callId: string }> = [];
    const secondCalls: Array<{ runId: string; input: unknown; callId: string }> = [];
    probeTurn("run-a", firstCalls).dispose();
    const session = sessionWith("codex-turn-b", probeTurn("run-b", secondCalls).tools);

    expect(await serve(session, call("codex-turn-a", "call_late"))).toEqual({
      success: false, contentItems: [{ type: "inputText", text: probeUnavailable }]
    });
    await serve(session, call("codex-turn-b", "call_live"));
    expect(firstCalls).toEqual([]);
    expect(secondCalls.map((entry) => entry.callId)).toEqual(["call_live"]);
  });

  it("fails closed on a foreign thread, a turn id not yet known, or malformed params", async () => {
    registerProbe();
    const calls: Array<{ runId: string; input: unknown; callId: string }> = [];
    const tools = probeTurn("run-a", calls).tools;
    const foreign = await serve(sessionWith("codex-turn-a", tools), { ...call("codex-turn-a", "c1"), threadId: "thread-2" });
    const early = await serve(sessionWith(undefined, tools), call("codex-turn-a", "c2"));
    const malformed = await serve(sessionWith("codex-turn-a", tools), { tool: "transport_probe" });
    expect([foreign.success, early.success, malformed.success]).toEqual([false, false, false]);
    expect(calls).toEqual([]);
  });
});
