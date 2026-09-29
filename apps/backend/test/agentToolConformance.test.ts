import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAgentRunnerToolSet } from "../src/agentTools/runnerToolSet";
import type { AgentToolHandler } from "../src/agentTools/dispatch";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerEvent } from "../src/runner/AgentRunner";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import type { ClaudeCodeMcpServerFactory } from "../src/runner/claudeCode/sdk";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import { CursorSdkRunner } from "../src/runner/cursor/CursorSdkRunner";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { PLAN_TOOLS_INSTRUCTION, PLAN_TOOL_IDS, planToolDefinitions, planToolHandlers } from "../src/plans/planTools";
import { memoryPlanWriter, planService } from "./support/planServiceHarness";
import { PROBE_TOOL_LOGICAL_ID, PROBE_TOOL_NAME } from "./support/probeAgentTool";
import {
  fakeClaudeToolQuery,
  reportFrom,
  scriptPrompt,
  writeCodexToolServer,
  writeCursorToolHost,
  writeDeepSeekToolRuntime,
  type ToolReport,
  type ToolScript
} from "./support/toolConformanceFakes";

/**
 * One conformance suite for AgentRoom tools, run against all four built-in
 * adapters (docs/plans/AGENT_PLAN_TOOLS_PLAN.md, Stage 4). Each fixture swaps
 * only the fake native agent; the scenarios, the session-supplied tool set,
 * and the assertions are shared. The set carries the six plan tools and a
 * non-plan probe tool that no adapter was taught about, which is the check
 * against plan-specific relay branches and copied tool lists.
 */

// The fake DeepSeek runtime simulates the plugin on the tools pipe, so the
// composition only has to name a plugin path; nothing loads it.
const FAKE_PLUGIN_PATH = "/agentroom-conformance/agentRoomToolsPlugin.js";
vi.mock("../src/runner/deepseek/cordis/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runner/deepseek/cordis/runtime")>()),
  resolveAgentRoomCordisPlugin: async () => FAKE_PLUGIN_PATH
}));

async function baseConfig(overrides: Partial<ServiceConfig>): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-tool-conformance-"));
  return {
    runnerKind: "codex", host: "127.0.0.1", port: 8787, workspaceRoot: root, stateDir: join(root, "state"),
    requireAuth: false, gitCommandTimeoutMs: 30_000, codexArgs: [], ...overrides
  } as ServiceConfig;
}

interface Fixture {
  name: string;
  /** What a restored native conversation knows about its tools. */
  resume: "registers" | "unknown" | "unsupported";
  create(): Promise<{ runner: AgentRunner; workspacePath: string; systemPrompts?: () => string[] }>;
}

const fixtures: Fixture[] = [
  {
    name: "cursor",
    resume: "registers",
    async create() {
      const config = await baseConfig({});
      return { runner: new CursorSdkRunner(config, { hostModulePath: await writeCursorToolHost() }), workspacePath: config.workspaceRoot };
    }
  },
  {
    name: "codex",
    resume: "unknown",
    async create() {
      const config = await baseConfig({ codexExecutable: process.execPath, codexArgs: [await writeCodexToolServer()], codexRunnerProtocol: "jsonrpc" });
      return { runner: new CodexAppServerRunner(config), workspacePath: config.workspaceRoot };
    }
  },
  {
    name: "claude_code",
    resume: "registers",
    async create() {
      const config = await baseConfig({});
      const record = { options: [] as Array<Record<string, unknown>> };
      // The real SDK's in-process MCP server, served to a fake child.
      const runner = new ClaudeCodeRunner(config, {
        loadQuery: async () => fakeClaudeToolQuery(record),
        loadMcpServer: async () => (await import("@anthropic-ai/claude-agent-sdk")).createSdkMcpServer as unknown as ClaudeCodeMcpServerFactory
      });
      const systemPrompts = () => record.options.map((options) => String((options.systemPrompt as { append?: string }).append ?? ""));
      return { runner, workspacePath: config.workspaceRoot, systemPrompts };
    }
  },
  {
    name: "deepseek",
    resume: "unsupported",
    async create() {
      const config = await baseConfig({
        deepseekExecutable: process.execPath,
        deepseekArgs: [await writeDeepSeekToolRuntime()],
        deepseekModel: "deepseek-v4-pro"
      });
      const composition = join(config.workspaceRoot, "cordis.yml");
      await writeFile(composition, `- id: agentroom-tools\n  name: ${JSON.stringify(FAKE_PLUGIN_PATH)}\n`);
      return { runner: new DeepSeekHarnessRunner({ ...config, deepseekCordisConfig: composition }), workspacePath: config.workspaceRoot };
    }
  }
];

const SESSION_TOOL_NAMES = [...planToolDefinitions.map((definition) => definition.name), PROBE_TOOL_NAME];

/** The set an AgentRoom session would supply: plan handlers plus the probe, bound to one turn. */
function sessionTools(input: {
  runId: string;
  sessionId: string;
  required?: boolean;
  probe?: AgentToolHandler;
  plans?: ReturnType<typeof planService>;
}) {
  const plans = input.plans ?? planService(memoryPlanWriter().writer);
  const catalog = [...PLAN_TOOL_IDS, PROBE_TOOL_LOGICAL_ID];
  const prepared = prepareAgentRunnerToolSet({
    runId: input.runId,
    sessionKey: input.sessionId,
    catalog,
    allowed: catalog,
    required: input.required ?? false,
    handlers: {
      ...planToolHandlers(plans, input.sessionId),
      [PROBE_TOOL_LOGICAL_ID]: input.probe ?? (async (_arguments, call) => `probe answered ${call.runId}`)
    },
    isLive: () => true
  });
  return { ...prepared, tools: { ...prepared.tools, instructions: PLAN_TOOLS_INSTRUCTION } };
}

async function runTurn(
  runner: AgentRunner,
  input: { runId: string; sessionId: string; workspacePath: string; script?: ToolScript; tools?: ReturnType<typeof sessionTools> }
): Promise<{ events: AgentRunnerEvent[]; report?: ToolReport; final?: AgentRunnerEvent }> {
  const events: AgentRunnerEvent[] = [];
  try {
    for await (const event of runner.run({
      runId: input.runId,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      prompt: scriptPrompt(input.script ?? {}),
      ...(input.tools ? { tools: input.tools.tools } : {})
    })) events.push(event);
  } finally {
    // What the session layer does at settlement.
    input.tools?.dispose();
  }
  const text = events.flatMap((event) => event.type === "agent_update" ? [event.message] : []).join("");
  return { events, report: reportFrom(text), final: events.at(-1) };
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function start(fixture: Fixture) {
  const created = await fixture.create();
  disposers.push(async () => created.runner.dispose?.());
  return created;
}

describe.each(fixtures)("AgentRoom tool conformance: $name", (fixture) => {
  it("registers every supplied tool and runs a whole plan through native calls in one turn", async () => {
    const { runner, workspacePath, systemPrompts } = await start(fixture);
    const tools = sessionTools({ runId: "turn-a", sessionId: "s-plan" });
    const step = (operationId: string, revision: number, stepId: string, status: string, note?: string) => ({
      name: "update_plan_step",
      arguments: { operationId, planId: "plan-1", expectedRevision: revision, stepId, status, ...(note ? { note } : {}) }
    });
    const { report, final } = await runTurn(runner, {
      runId: "turn-a", sessionId: "s-plan", workspacePath, tools,
      script: { calls: [
        { name: "create_plan", arguments: { operationId: "op-1", objective: "Ship", completionCriteria: "Both done", steps: [{ description: "one" }, { description: "two" }] } },
        { name: "execute_plan", arguments: { operationId: "op-2", planId: "plan-1", expectedRevision: 1 } },
        step("op-3", 2, "step-1", "completed", "first done"),
        step("op-4", 3, "step-2", "in_progress"),
        step("op-5", 4, "step-2", "completed", "second done"),
        { name: "finish_plan", arguments: { operationId: "op-6", planId: "plan-1", expectedRevision: 5, outcome: "completed", summary: "Both steps are done." } },
        { name: "get_plan", arguments: {} },
        { name: PROBE_TOOL_NAME, arguments: {} }
      ] }
    });

    expect(final, JSON.stringify(final)).toMatchObject({ type: "run_succeeded" });
    expect(report?.tools).toEqual(expect.arrayContaining(SESSION_TOOL_NAMES));
    expect(report?.notice).toBe(false);
    const envelopes = report!.results.slice(0, 7).map((text) => JSON.parse(text));
    expect(envelopes.every((envelope) => envelope.ok)).toBe(true);
    expect(envelopes.map((envelope) => envelope.plan.revision)).toEqual([1, 2, 3, 4, 5, 6, 6]);
    expect(envelopes[6].plan).toMatchObject({ status: "completed", summary: "Both steps are done." });
    expect(report!.results[7]).toBe("probe answered turn-a");
    if (systemPrompts) expect(systemPrompts()[0]).toContain(PLAN_TOOLS_INSTRUCTION);
  });

  it("binds each turn afresh and refuses a delayed call stamped with the previous turn", async () => {
    const { runner, workspacePath } = await start(fixture);
    const calls: string[] = [];
    const probe: AgentToolHandler = async (_arguments, call) => {
      calls.push(call.runId);
      return `probe answered ${call.runId}`;
    };
    const first = await runTurn(runner, {
      runId: "turn-1", sessionId: "s-rebind", workspacePath,
      tools: sessionTools({ runId: "turn-1", sessionId: "s-rebind", probe }),
      script: { calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });
    const second = await runTurn(runner, {
      runId: "turn-2", sessionId: "s-rebind", workspacePath,
      tools: sessionTools({ runId: "turn-2", sessionId: "s-rebind", probe }),
      script: { late: { name: PROBE_TOOL_NAME, arguments: {} }, calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });

    expect(first.report?.results).toEqual(["probe answered turn-1"]);
    expect(second.report?.late).toBe("Probe unavailable.");
    expect(second.report?.results).toEqual(["probe answered turn-2"]);
    expect(calls).toEqual(["turn-1", "turn-2"]);
  });

  it("fails a turn that requires tools its child never registered and warns an optional one", async () => {
    const { runner, workspacePath } = await start(fixture);
    const bare = await runTurn(runner, { runId: "turn-bare", sessionId: "s-late-tools", workspacePath });
    expect(bare.final).toMatchObject({ type: "run_succeeded" });

    const required = await runTurn(runner, {
      runId: "turn-required", sessionId: "s-late-tools", workspacePath,
      tools: sessionTools({ runId: "turn-required", sessionId: "s-late-tools", required: true })
    });
    expect(required.final).toMatchObject({ type: "run_failed" });
    expect((required.final as { error: string }).error).toMatch(/AgentRoom tools|tool catalog changed/);

    if (fixture.resume === "unsupported") return;
    const optional = await runTurn(runner, {
      runId: "turn-optional", sessionId: "s-late-tools", workspacePath,
      tools: sessionTools({ runId: "turn-optional", sessionId: "s-late-tools" })
    });
    expect(optional.final).toMatchObject({ type: "run_succeeded" });
    expect(optional.report?.notice).toBe(true);
  });

  it("aborts an in-flight call when its turn is cancelled", async () => {
    const { runner, workspacePath } = await start(fixture);
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const probe: AgentToolHandler = (_arguments, call) => new Promise<string>((resolve) => {
      started();
      call.signal.addEventListener("abort", () => { aborted = true; resolve("late"); }, { once: true });
    });
    const tools = sessionTools({ runId: "turn-cancel", sessionId: "s-cancel", probe });
    const turn = runTurn(runner, {
      runId: "turn-cancel", sessionId: "s-cancel", workspacePath, tools,
      script: { calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });
    await reached;
    await runner.cancel("turn-cancel");
    tools.dispose();
    const { final } = await turn;
    expect(aborted).toBe(true);
    expect(final?.type).toMatch(/run_failed|run_succeeded/);
  });

  it.skipIf(fixture.resume === "unsupported")("serves tools in a restored native conversation as far as it can confirm them", async () => {
    const { runner, workspacePath } = await start(fixture);
    // A restart hands back the tool names the service persisted for the conversation.
    runner.rememberResumableId?.({ sessionId: "s-resume", nativeSessionId: "native-restored", interrupted: false, registeredToolNames: SESSION_TOOL_NAMES });
    const required = await runTurn(runner, {
      runId: "turn-restored", sessionId: "s-resume", workspacePath,
      tools: sessionTools({ runId: "turn-restored", sessionId: "s-resume", required: true }),
      script: { calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });
    expect(required.final).toMatchObject({ type: "run_succeeded" });
    expect(required.report?.results).toEqual(["probe answered turn-restored"]);
    if (fixture.resume === "registers") return;

    // The restore keeps a catalog it cannot describe, so the recorded names
    // survive for the next restart; without them a required turn fails and an
    // optional one is told the tools are unconfirmed but still dispatches.
    expect(runner.nativeToolRegistration?.("s-resume")?.names).toEqual(SESSION_TOOL_NAMES);
    runner.rememberResumableId?.({ sessionId: "s-unrecorded", nativeSessionId: "native-unrecorded", interrupted: false });
    const unrecorded = await runTurn(runner, {
      runId: "turn-unrecorded", sessionId: "s-unrecorded", workspacePath,
      tools: sessionTools({ runId: "turn-unrecorded", sessionId: "s-unrecorded", required: true })
    });
    expect(unrecorded.final).toMatchObject({ type: "run_failed" });
    const optional = await runTurn(runner, {
      runId: "turn-unrecorded-2", sessionId: "s-unrecorded", workspacePath,
      tools: sessionTools({ runId: "turn-unrecorded-2", sessionId: "s-unrecorded" }),
      script: { calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });
    expect(optional.report?.notice).toBe(true);
    expect(optional.report?.results).toEqual(["probe answered turn-unrecorded-2"]);
  });
});

describe("Claude Code tool-use ownership", () => {
  it("refuses a tool use announced before any turn awaits a result instead of crediting the active turn", async () => {
    const config = await baseConfig({});
    // The stray block lands while the first turn is active but has not yet
    // joined the turns awaiting a result, the window the runner must not guess in.
    const record = { options: [] as Array<Record<string, unknown>>, strayToolUseOnStatus: "toolu_stray" };
    const runner = new ClaudeCodeRunner(config, {
      loadQuery: async () => fakeClaudeToolQuery(record),
      loadMcpServer: async () => (await import("@anthropic-ai/claude-agent-sdk")).createSdkMcpServer as unknown as ClaudeCodeMcpServerFactory
    });
    disposers.push(async () => runner.dispose?.());
    const calls: string[] = [];
    const probe: AgentToolHandler = async (_arguments, call) => {
      calls.push(call.runId);
      return `probe answered ${call.runId}`;
    };
    const { report, final } = await runTurn(runner, {
      runId: "turn-owner", sessionId: "s-owner", workspacePath: config.workspaceRoot,
      tools: sessionTools({ runId: "turn-owner", sessionId: "s-owner", probe }),
      script: { late: { name: PROBE_TOOL_NAME, arguments: {}, toolUseId: "toolu_stray" }, calls: [{ name: PROBE_TOOL_NAME, arguments: {} }] }
    });

    expect(final).toMatchObject({ type: "run_succeeded" });
    expect(report?.late).toBe("Probe unavailable.");
    expect(calls).toEqual(["turn-owner"]);
  });
});
