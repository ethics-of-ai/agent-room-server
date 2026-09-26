import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { advertisedAgentTools } from "../src/agentTools/dispatch";
import { PROBE_TOOL_LOGICAL_ID, PROBE_TOOL_NAME } from "./support/probeAgentTool";
import type { AgentRunnerEvent, AgentRunnerToolSet } from "../src/runner/AgentRunner";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { config } from "./support/agentSessionHarness";

const checkout = process.env.DEEPSEEK_HARNESS_CHECKOUT;
const describeHarness = checkout ? describe : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function collect(iterable: AsyncIterable<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> {
  const events: AgentRunnerEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describeHarness("DeepSeek real Cordis AgentRoom tools probe", () => {
  it("loads, invokes, cancels, unbinds, and accepts a clean second turn on the pinned runtime", async () => {
    const harnessRoot = resolve(checkout as string);
    const fixtureRoot = await mkdtemp(join(harnessRoot, "examples/jsonrpc-agent/.agentroom-tools-probe-"));
    roots.push(fixtureRoot);
    const composition = join(fixtureRoot, "cordis.yml");
    const probeLlm = resolve("test/fixtures/deepseek/agentRoomProbeLlm.mjs");
    const agentRoomPlugin = resolve("dist/runner/deepseek/cordis/agentRoomToolsPlugin.js");
    await writeFile(composition, [
      "- id: sdk-jsonrpc-server",
      "  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
      "- id: probe-llm",
      `  name: '${probeLlm}'`,
      "- id: agent-core",
      "  name: '@deepseek-ai/dsh-agent-spine-demo'",
      "  config:",
      "    persona: 'Call the available probe tool exactly once, then finish.'",
      "    workspaceContext: false",
      "    skills:",
      "      enabled: false",
      "    toolBash: false",
      "    toolJobs: false",
      "- id: sessions",
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      "  config:",
      "    root: !!js process.env.DSH_SESSION_ROOT",
      "    compression: none",
      "- id: agentroom-tools",
      `  name: '${agentRoomPlugin}'`,
      ""
    ].join("\n"));

    const serviceConfig = await config({
      deepseekExecutable: process.execPath,
      deepseekArgs: [join(harnessRoot, "packages/examples/jsonrpc-demo/lib/bin.js")],
      deepseekCordisConfig: composition,
      deepseekProvider: "agentroom-probe",
      deepseekModel: "probe"
    });
    process.env.AGENTROOM_PROBE_LLM_MODULE = pathToFileURL(
      join(harnessRoot, "packages/llm/llm/lib/index.js")
    ).href;
    process.env.AGENTROOM_PROBE_TOOL_NAME = PROBE_TOOL_NAME;
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const calls: Array<{ runId: string; callId: string }> = [];
    const catalog: AgentRunnerToolSet["catalog"] = advertisedAgentTools([
      PROBE_TOOL_LOGICAL_ID
    ]);
    const tools = (runId: string, invoke: AgentRunnerToolSet["binding"]["invoke"]): AgentRunnerToolSet => ({
      catalog,
      binding: { runId, allowedNames: [PROBE_TOOL_NAME], invoke }
    });

    try {
      for (const runId of ["probe-turn-1", "probe-turn-2"]) {
        const events = await collect(runner.run({
          runId,
          sessionId: "probe-session",
          workspacePath: fixtureRoot,
          prompt: "Run the transport probe.",
          tools: tools(runId, async (invocation) => {
            calls.push({ runId, callId: invocation.callId });
            return JSON.stringify({ ok: true, runId });
          })
        }));
        expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "run_succeeded" });
      }
      expect(calls.map((call) => call.runId)).toEqual(["probe-turn-1", "probe-turn-2"]);
      expect(new Set(calls.map((call) => call.callId)).size).toBe(2);

      let invocationStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => { invocationStarted = resolveStarted; });
      let signalAborted = false;
      const cancelledRun = collect(runner.run({
        runId: "probe-turn-cancel",
        sessionId: "probe-session",
        workspacePath: fixtureRoot,
        prompt: "Run and wait for cancellation.",
        tools: tools("probe-turn-cancel", async (invocation) => {
          invocationStarted();
          return new Promise((resolveResult) => {
            invocation.signal.addEventListener("abort", () => {
              signalAborted = true;
              resolveResult("cancelled");
            }, { once: true });
          });
        })
      }));
      await started;
      await runner.cancel("probe-turn-cancel");
      const cancelledEvents = await cancelledRun;
      expect(signalAborted).toBe(true);
      expect(cancelledEvents.at(-1)).toMatchObject({ type: "run_failed" });
    } finally {
      await runner.dispose();
      delete process.env.AGENTROOM_PROBE_LLM_MODULE;
      delete process.env.AGENTROOM_PROBE_TOOL_NAME;
    }
  }, 30_000);
});
