import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { prepareAgentRunnerToolSet } from "../src/agentTools/runnerToolSet";
import { PROBE_TOOL_LOGICAL_ID, PROBE_TOOL_NAME } from "./support/probeAgentTool";
import { config } from "./support/agentSessionHarness";

const checkout = process.env.DEEPSEEK_HARNESS_CHECKOUT;
const roots: string[] = [];
afterEach(async () => {
  delete process.env.AGENTROOM_PROBE_LLM_MODULE;
  delete process.env.AGENTROOM_PROBE_TOOL_NAME;
  delete process.env.AGENTROOM_PROBE_TOOL_ARGUMENTS;
  delete process.env.AGENTROOM_PROBE_TOOL_SEQUENCE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!checkout)("managed DeepSeek real runtime", () => {
  it("proves a same-id prompt after process loss starts fresh despite JSONL persistence", async () => {
    const { root, serviceConfig } = await managedFixture();
    process.env.AGENTROOM_PROBE_TOOL_NAME = "__history_probe__";
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const collect = async (active: DeepSeekHarnessRunner, runId: string, prompt: string) => {
      const events: AgentRunnerEvent[] = [];
      for await (const event of active.run({ runId, sessionId: "persisted", workspacePath: root, prompt })) events.push(event);
      expect(events.at(-1)).toEqual({ type: "run_succeeded" });
      return events.flatMap((event) => event.type === "agent_update" ? [event.message] : []).join("");
    };
    try {
      expect(await collect(runner, "before", "history-marker-before-restart")).toContain("retained-marker=true");
      expect(await collect(runner, "same-process", "Continue")).toContain("retained-marker=true");
    } finally { await runner.dispose(); }
    // Investigation deliberately bypasses AgentRoom's durable-session restore
    // refusal. Reusing an id alone succeeds but loses the original history.
    const restarted = new DeepSeekHarnessRunner(serviceConfig);
    try {
      expect(await collect(restarted, "fresh-process", "Continue")).toContain("retained-marker=false");
    } finally { await restarted.dispose(); }
  }, 30_000);

  it("runs the explicit provider check with no tools and a bounded output budget", async () => {
    const { serviceConfig } = await managedFixture();
    process.env.AGENTROOM_PROBE_TOOL_NAME = "__history_probe__";
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    try { expect(await runner.testConnection()).toMatchObject({ ok: true }); }
    finally { await runner.dispose(); }
  }, 35_000);

  it("uses question and probe handlers across turns in one stable managed catalog", async () => {
    const { root, serviceConfig } = await managedFixture();
    process.env.AGENTROOM_PROBE_TOOL_SEQUENCE = JSON.stringify(["ask_user_question", PROBE_TOOL_NAME]);
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    let reads = 0;
    try {
      for (const runId of ["question", "probe"]) {
        const prepared = prepareAgentRunnerToolSet({ runId, sessionKey: "combined", catalog: [PROBE_TOOL_LOGICAL_ID],
          allowed: [PROBE_TOOL_LOGICAL_ID], isLive: () => true,
          handlers: { [PROBE_TOOL_LOGICAL_ID]: async () => { reads++; return "fixture probe"; } } });
        const events: AgentRunnerEvent[] = [];
        try {
          for await (const event of runner.run({ runId, sessionId: "combined", workspacePath: root, prompt: "Use the tool", tools: prepared.tools })) {
            events.push(event);
            if (event.type === "agent_activity" && event.activity.canonical?.kind === "question_requested") {
              runner.answerQuestionRequest({ sessionId: "combined", requestId: event.activity.canonical.requestId!,
                answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"] }] });
            }
          }
          expect(events.at(-1)).toEqual({ type: "run_succeeded" });
        } finally { prepared.dispose(); }
      }
      expect(reads).toBe(1);
    } finally { await runner.dispose(); }
  }, 30_000);

  it("boots generated configuration, asks native questions across two turns, and cancels a pending question", async () => {
    const { root, source, serviceConfig } = await managedFixture();
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    try {
      expect((await runner.getCapabilities()).checks).toContainEqual(expect.objectContaining({ id: "agent_tools", status: "ready" }));
      for (const runId of ["first", "second", "cancel"]) {
        const events: AgentRunnerEvent[] = [];
        for await (const event of runner.run({ runId, sessionId: "managed-session", workspacePath: root, prompt: "Ask the probe question." })) {
          events.push(event);
          if (event.type !== "agent_activity" || event.activity.canonical?.kind !== "question_requested") continue;
          const request = event.activity.canonical;
          if (runId === "cancel") await runner.cancel(runId);
          else expect(await runner.answerQuestionRequest({ sessionId: "managed-session", requestId: request.requestId!,
            answers: [{ setId: request.questionSets[0].setId, selectedOptionIds: [request.questionSets[0].options[0].optionId] }]
          })).toBe("answered");
        }
        expect(events.at(-1)?.type).toBe(runId === "cancel" ? "run_failed" : "run_succeeded");
        expect(events.filter((event) => event.type === "agent_activity" && event.activity.canonical?.kind === "question_requested"), JSON.stringify(events)).toHaveLength(1);
      }
      expect(await readFile(source, "utf8")).toBe("# package resolution source only\n");
    } finally { await runner.dispose(); }
  }, 30_000);
});

async function managedFixture() {
    const root = await mkdtemp(join(resolve(checkout!), "examples/jsonrpc-agent/.agentroom-managed-"));
    roots.push(root);
    const source = join(root, "cordis.yml");
    await writeFile(source, "# package resolution source only\n");
    // Replace only the provider adapter in an otherwise real installed package
    // graph. No provider credential or network model call is used by this probe.
    const provider = join(root, "node_modules/@deepseek-ai/dsh-llm-deepseek");
    await mkdir(provider, { recursive: true });
    await writeFile(join(provider, "package.json"), JSON.stringify({
      name: "@deepseek-ai/dsh-llm-deepseek", main: resolve("test/fixtures/deepseek/agentRoomProbeLlm.mjs")
    }));
    process.env.AGENTROOM_PROBE_LLM_MODULE = pathToFileURL(join(resolve(checkout!), "packages/llm/llm/lib/index.js")).href;
    process.env.AGENTROOM_PROBE_TOOL_NAME = "ask_user_question";
    process.env.AGENTROOM_PROBE_TOOL_ARGUMENTS = JSON.stringify({ questions: [{
      question: "Which option?", selection: "single", discussion: "none", options: [{ label: "A" }, { label: "B" }]
    }] });
    const serviceConfig = await config({
      stateDir: join(root, "Application Support/state"), deepseekExecutable: process.execPath,
      deepseekArgs: [join(resolve(checkout!), "packages/examples/jsonrpc-demo/lib/bin.js")],
      deepseekCordisConfig: source, deepseekCompositionMode: "managed", deepseekProvider: "agentroom-probe",
      deepseekModel: "probe", clarifyingQuestionsEnabled: true
    });
    return { root, source, serviceConfig };
}
