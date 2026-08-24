import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { DeepSeekHarnessRunner } from "../src/runner/deepseek/DeepSeekHarnessRunner";
import { buildServer } from "../src/server";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-deepseek-"));
  return {
    runnerKind: "deepseek",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    deepseekExecutable: process.execPath,
    // The real runtime refuses to start without a composition, so every runner
    // fixture carries one. The fake runtime below ignores it — what is under
    // test here is the protocol, not the plugin graph.
    deepseekCordisConfig: join(root, "cordis.yml"),
    deepseekArgs: [],
    deepseekModel: "deepseek-v4-pro",
    ...overrides
  } as ServiceConfig;
};

const collect = async (events: AsyncIterable<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> => {
  const collected: AgentRunnerEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

/**
 * Whether the fake runtime wrote its marker within a bounded wait.
 *
 * The teardown ladder runs in the background — the host frees the session slot
 * without blocking on a child that may not go quietly — so a marker's absence
 * has to be proved against a deadline rather than read once and trusted.
 */
const appears = async (path: string, timeoutMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path);
};

const assistantText = (events: AgentRunnerEvent[]): string =>
  events.flatMap((event) => (event.type === "agent_update" ? [event.message] : [])).join("");

const canonicalOf = (events: AgentRunnerEvent[], kind: string): Array<Record<string, unknown>> =>
  events
    .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
    .map((event) => event.activity.canonical as Record<string, unknown> | undefined)
    .filter((canonical): canonical is Record<string, unknown> => canonical?.kind === kind);

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("DeepSeekHarnessRunner", () => {
  it("hands the runtime the workspace, streams its session log, and settles on the turn's own end", async () => {
    const runtime = await writeFakeRuntime();
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello DeepSeek"
    }));
    await runner.dispose();

    // The session's own id is what the runtime was handed, which is also what
    // continues the conversation after a child is gone.
    expect(events).toContainEqual({
      type: "agent_activity",
      activity: expect.objectContaining({
        kind: "deepseek_session_started",
        canonical: { kind: "session_started" },
        runner: expect.objectContaining({ nativeSessionId: "agent-session-1" })
      })
    });
    expect(assistantText(events)).toContain("cwd=" + serviceConfig.workspaceRoot);
    expect(assistantText(events)).toContain("model=deepseek-v4-pro");
    expect(events.map((event) => (event.type === "agent_activity" ? event.activity.canonical?.kind : undefined)))
      .toContain("tool_started");
    expect(events.at(-1)).toEqual({ type: "run_succeeded" });
    expect(events.at(-2)).toMatchObject({
      type: "runner_audit",
      audit: { phase: "completed", runnerKind: "deepseek", status: "succeeded" }
    });
  });

  it("holds a prompt-contract question open, accepts the human answer, and resumes the same AgentRoom turn", async () => {
    const runtime = await writeFakeRuntime({
      askQuestion: true,
      sensitiveQuestion: true,
      idleBeforeQuestionTurnEnd: true,
      delayContinuationCompletion: true
    });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "agentroom-turn-question",
        sessionId: "agent-session-question",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "Choose the target"
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => canonicalOf(events, "question_requested").length > 0);
    const requested = canonicalOf(events, "question_requested")[0];
    const requestId = requested.requestId as string;
    expect(requestId).toMatch(/^question-/);
    expect(requested.questionSets).toEqual([
      expect.objectContaining({
        setId: "set-1",
        header: "Target",
        selection: "single",
        discussion: "optional",
        sensitive: true
      })
    ]);
    expect(runner.answerQuestionRequest({
      sessionId: "agent-session-question",
      requestId,
      answers: [{ setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "Keep this private" }]
    })).toBe("answered");

    await run;
    const resolved = canonicalOf(events, "question_resolved")[0];
    expect(resolved).toEqual({
      kind: "question_resolved",
      requestId,
      status: "answered",
      decidedBy: "human",
      questionAnswers: [{ setId: "set-1", selectedOptionIds: ["opt-2"] }]
    });
    expect(assistantText(events)).toContain("continued with macOS");
    expect(assistantText(events)).toContain("continuation-finished");
    expect(assistantText(events)).toContain("private-note-received");
    expect(assistantText(events)).not.toContain("Keep this private");
    expect(assistantText(events)).not.toContain("<agentroom-question>");
    expect(assistantText(events)).not.toContain("set-1");
    expect(events.at(-1)).toEqual({ type: "run_succeeded" });
    expect(runner.answerQuestionRequest({
      sessionId: "agent-session-question",
      requestId,
      answers: []
    })).toBe("unknown_request");
    await runner.dispose();
  });

  it("carries a DeepSeek question through the HTTP route, durable transcript, and completed turn", async () => {
    const runtime = await writeFakeRuntime({ askQuestion: true, sensitiveQuestion: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const { app, eventBus } = await buildServer({ config: serviceConfig, runners: { deepseek: runner } });
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: serviceConfig.workspaceRoot }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: workspace.json().workspace.id, runnerKind: "deepseek" }
    });
    const sessionId = session.json().session.id as string;
    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "Choose the target" }
    });
    expect(turn.statusCode).toBe(202);

    await waitFor(() => eventBus.getRecentEvents().some((event) => event.type === "coding_question_requested"));
    const requested = eventBus.getRecentEvents().find((event) => event.type === "coding_question_requested");
    if (!requested || requested.type !== "coding_question_requested") throw new Error("Missing question request");
    const requestId = requested.payload.requestId;
    const outstanding = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${sessionId}/questions`
    });
    expect(outstanding.json().questions).toEqual([
      expect.objectContaining({ requestId, questionSets: requested.payload.questionSets })
    ]);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${requestId}`,
      payload: {
        answers: [{ setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "Keep this private" }]
      }
    });
    expect(answered.statusCode).toBe(200);
    await waitFor(() => eventBus.getRecentEvents().some((event) => event.type === "coding_turn_completed"));

    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(detail.json().session.status).toBe("idle");
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const answer = messages.json().messages.find(
      (message: { context?: { questionRequestId?: string } }) => message.context?.questionRequestId === requestId
    );
    expect(answer.content).toContain("macOS");
    expect(answer.content).not.toContain("Keep this private");
    expect(messages.json().messages.some(
      (message: { role: string; content: string }) => message.role === "assistant" && message.content.includes("continued with macOS")
    )).toBe(true);
    expect(eventBus.getRecentEvents()).toContainEqual(expect.objectContaining({
      type: "agent_question_resolved",
      payload: expect.objectContaining({
        audit: expect.objectContaining({ decidedBy: "human", status: "answered" })
      })
    }));

    await app.close();
  });

  it("continues without inventing an answer when a prompt-contract question times out", async () => {
    const runtime = await writeFakeRuntime({ askQuestion: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig, { questionTimeoutMs: 30 });
    const events = await collect(runner.run({
      runId: "agentroom-turn-timeout",
      sessionId: "agent-session-timeout",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Choose the target"
    }));

    expect(canonicalOf(events, "question_resolved")[0]).toMatchObject({
      status: "timeout",
      decidedBy: "timeout"
    });
    expect(assistantText(events)).toContain("continued with best judgment");
    expect(events.at(-1)).toEqual({ type: "run_succeeded" });
    await runner.dispose();
  });

  it("closes an outstanding question before reporting a Harness child failure", async () => {
    const runtime = await writeFakeRuntime({ askQuestion: true, dieAfterQuestion: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const events = await collect(runner.run({
      runId: "agentroom-turn-question-crash",
      sessionId: "agent-session-question-crash",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Choose the target"
    }));

    const requested = canonicalOf(events, "question_requested")[0];
    expect(canonicalOf(events, "question_resolved")[0]).toEqual({
      kind: "question_resolved",
      requestId: requested.requestId,
      status: "cancelled"
    });
    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      error: expect.stringContaining("failed after asking")
    });
    await runner.dispose();
  });

  it("leaves prompt-contract blocks as prose when clarifying questions are disabled", async () => {
    const runtime = await writeFakeRuntime({ askQuestion: true });
    const serviceConfig = await config({ deepseekArgs: [runtime], clarifyingQuestionsEnabled: false });
    const runner = new DeepSeekHarnessRunner(serviceConfig);
    const events = await collect(runner.run({
      runId: "agentroom-turn-disabled",
      sessionId: "agent-session-disabled",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Choose the target"
    }));

    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    expect(assistantText(events)).toContain("<agentroom-question>");
    expect(events.at(-1)).toEqual({ type: "run_succeeded" });
    await runner.dispose();
  });

  it("refuses to spawn at all without the composition the runtime demands", async () => {
    // The real runtime prints one line of usage to stderr and exits 1 when it
    // has neither $DSH_CORDIS_CONFIG nor an argv positional. Failing here says
    // which piece of setup is missing instead of relaying that.
    const runtime = await writeFakeRuntime();
    const serviceConfig = await config({ deepseekArgs: [runtime], deepseekCordisConfig: undefined });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    await expect(collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }))).rejects.toThrow(/DEEPSEEK_CORDIS_CONFIG/);
    await runner.dispose();
  });

  it("asks the runtime to shut down before signalling it when a session is released", async () => {
    // `shutdown` is what lets the plugin flush and dispose to quiescence; a
    // SIGTERM-only teardown ends a composition with JSONL persistence mid-write.
    const marker = join(await mkdtemp(join(tmpdir(), "agentroom-deepseek-shutdown-")), "shutdown");
    const runtime = await writeFakeRuntime({ shutdownMarker: marker });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.closeSession("agent-session-1");

    expect(await appears(marker)).toBe(true);
    await runner.dispose();
  });

  it("skips the shutdown request when a turn is cancelled", async () => {
    // Cancelling means stop, and `shutdown` disposes to *quiescence* — it would
    // let the work the operator just stopped run on to completion. The ladder
    // therefore enters below that rung.
    const marker = join(await mkdtemp(join(tmpdir(), "agentroom-deepseek-cancel-")), "shutdown");
    const runtime = await writeFakeRuntime({ shutdownMarker: marker });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    for await (const event of runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "HANG please"
    })) {
      if (event.type === "agent_update") await runner.cancel("agentroom-turn-1");
    }

    expect(await appears(marker)).toBe(false);
    await runner.dispose();
  });

  it("refuses a child that is not the SDK runtime instead of failing later on a shape", async () => {
    // The usual cause is DEEPSEEK_EXECUTABLE pointing at the `dsh` launcher,
    // which boots profiles and serves no SDK protocol. Naming that beats a turn
    // that dies on an unrecognized frame.
    const runtime = await writeFakeRuntime({ serverName: "some-other-server" });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.dispose();

    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      error: expect.stringContaining("dsh-jsonrpc-agent")
    });
  });

  it("tears down a registered child when initialize rejects instead of reusing it", async () => {
    const runtime = await writeFakeRuntime({ rejectInitialize: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const first = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "first"
    }));
    const second = await collect(runner.run({
      runId: "agentroom-turn-2",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "second"
    }));
    await runner.dispose();

    expect(first.at(-1)).toMatchObject({ type: "run_failed", error: "initialize refused" });
    // A leaked registered child would skip initialize and accept this prompt.
    expect(second.at(-1)).toMatchObject({ type: "run_failed", error: "initialize refused" });
  });

  it("reports a runtime it cannot start as unready rather than as an empty catalog", async () => {
    const serviceConfig = await config({ deepseekExecutable: undefined });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const capabilities = await runner.getCapabilities();
    await runner.dispose();

    expect(capabilities.runnerKind).toBe("deepseek");
    expect(capabilities.error).toContain("DEEPSEEK_EXECUTABLE");
    // The catalog is still served: a client renders the picker and the error
    // beside it rather than an empty control with no explanation.
    expect(capabilities.settings.models.length).toBeGreaterThan(0);
  });

  it("proves readiness by completing the handshake, and keeps an operator's own model in the catalog", async () => {
    const runtime = await writeFakeRuntime();
    const serviceConfig = await config({ deepseekArgs: [runtime], deepseekModel: "deepseek-v5-unreleased" });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const capabilities = await runner.getCapabilities();
    await runner.dispose();

    expect(capabilities.error).toBeUndefined();
    expect(capabilities.settings.models.map((model) => model.id)).toContain("deepseek-v5-unreleased");
    expect(capabilities.settings.defaultSettings.model).toBe("deepseek-v5-unreleased");
  });

  it("cancels by killing the runtime and refuses a silently fresh continuation", async () => {
    // The protocol has no prompt-cancel method and the selected composition may
    // have no persistence. A same-id follow-up must therefore fail clearly.
    const runtime = await writeFakeRuntime();
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const stream = runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "HANG please"
    });
    const collected: AgentRunnerEvent[] = [];
    for await (const event of stream) {
      collected.push(event);
      if (event.type === "agent_update") {
        await runner.cancel("agentroom-turn-1");
      }
    }

    expect(collected.at(-1)).toMatchObject({ type: "run_failed", error: expect.stringContaining("interrupted") });

    const followUp = await collect(runner.run({
      runId: "agentroom-turn-2",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "carry on"
    }));
    const newSession = await collect(runner.run({
      runId: "agentroom-turn-3",
      sessionId: "agent-session-2",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "start over"
    }));
    await runner.dispose();

    expect(followUp.at(-1)).toMatchObject({
      type: "run_failed",
      error: expect.stringContaining("create a new AgentRoom session")
    });
    expect(assistantText(newSession)).toContain("session=agent-session-2");
    expect(newSession.at(-1)).toEqual({ type: "run_succeeded" });
  });

  it("settles on the whole-agent idle transition when the runtime records no turn end", async () => {
    // The backstop. A turn that never settles is a worse failure than one
    // settled a beat early on the runtime's own running → idle transition.
    const runtime = await writeFakeRuntime({ omitTurnEnd: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.dispose();

    expect(events.at(-1)).toEqual({ type: "run_succeeded" });
  });

  it("ignores the session log of the sub-agents the harness starts", async () => {
    // The runtime notifies for every session in its context, including children.
    // Only this session's own log is this turn's.
    const runtime = await writeFakeRuntime({ emitForeignSession: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.dispose();

    expect(assistantText(events)).not.toContain("SUBAGENT");
  });

  it("fails the turn with the runtime's own stderr when the child dies", async () => {
    const runtime = await writeFakeRuntime({ dieOnPrompt: true });
    const serviceConfig = await config({ deepseekArgs: [runtime] });
    const runner = new DeepSeekHarnessRunner(serviceConfig);

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      error: expect.stringContaining("could not compose the plugin graph")
    });

    const followUp = await collect(runner.run({
      runId: "agentroom-turn-2",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "retry"
    }));
    await runner.dispose();

    expect(followUp.at(-1)).toMatchObject({
      type: "run_failed",
      error: expect.stringContaining("create a new AgentRoom session")
    });
  });
});

/**
 * A stand-in for `@deepseek-ai/dsh-sdk-jsonrpc-server`: it speaks the same
 * newline-delimited JSON-RPC and emits the same session-log envelopes, which is
 * the whole contract this adapter depends on.
 */
async function writeFakeRuntime(options: {
  serverName?: string;
  omitTurnEnd?: boolean;
  emitForeignSession?: boolean;
  dieOnPrompt?: boolean;
  rejectInitialize?: boolean;
  shutdownMarker?: string;
  askQuestion?: boolean;
  sensitiveQuestion?: boolean;
  dieAfterQuestion?: boolean;
  idleBeforeQuestionTurnEnd?: boolean;
  delayContinuationCompletion?: boolean;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-dsh-"));
  const path = join(root, "fake-dsh-runtime.cjs");
  await writeFile(path, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });

const options = ${JSON.stringify(options)};
let seq = 0;
let initialize;
let promptNumber = 0;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function event(sessionId, type, data) {
  send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, seq: seq++, time: Date.now(), data } } });
}

function status(sessionId, value) {
  send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: value } });
}

rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    initialize = message.params;
    if (options.rejectInitialize) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "initialize refused" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { serverInfo: { name: options.serverName || "deepseek-harness-sdk-runtime", version: "0.0.1" } }
    });
    return;
  }
  if (message.method === "shutdown") {
    // The real plugin answers, flushes, disposes to quiescence, and exits 0.
    // The marker is how the test sees that the ladder started at this rung
    // rather than going straight to a signal.
    if (options.shutdownMarker) require("node:fs").writeFileSync(options.shutdownMarker, "shutdown");
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    process.exit(0);
  }
  if (message.method !== "session/prompt") return;

  if (options.dieOnPrompt) {
    process.stderr.write("dsh: could not compose the plugin graph\\n");
    process.exit(3);
  }

  const sessionId = message.params.sessionId;
  const text = (message.params.contentBlocks || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  promptNumber += 1;
  const turn = promptNumber;
  send({ jsonrpc: "2.0", id: message.id, result: { messageId: "message-" + promptNumber } });

  status(sessionId, "running");
  event(sessionId, "request/header", { reason: promptNumber === 1 ? "initial" : "change" });
  event(sessionId, "request/context", { provider: initialize.provider, model: initialize.model, contextWindow: 128000 });
  event(sessionId, "turn/start", { turn });
  event(sessionId, "assistant/chunk", {
    turn,
    step: 1,
    chunk: {
      type: "text-delta",
      index: 0,
      text: promptNumber === 1
        ? "session=" + sessionId + " cwd=" + initialize.cwd + " model=" + initialize.model
        : "continued with " + (
            text.includes("macOS")
              ? "macOS " + (text.includes("Keep this private") ? "private-note-received" : "")
              : text.includes("best judgment") ? "best judgment" : "the answer"
          )
    }
  });

  if (options.emitForeignSession) {
    event(sessionId + "-child", "assistant/chunk", {
      chunk: { type: "text-delta", index: 0, text: "SUBAGENT output" }
    });
  }

  // A turn the caller asked to hang: work started and nothing settles it, which
  // is the state a cancel has to resolve.
  if (text.includes("HANG")) return;

  if (options.askQuestion && promptNumber === 1) {
    const question = JSON.stringify({
      sets: [{
        header: "Target",
        prompt: "Which client should land first?",
        selection: "single",
        options: [
          { label: "visionOS", description: "Ship the spatial client first" },
          { label: "macOS", description: "Ship the operator app first" }
        ],
        discussion: "optional",
        sensitive: Boolean(options.sensitiveQuestion)
      }]
    });
    event(sessionId, "assistant/chunk", {
      turn,
      step: 1,
      chunk: { type: "text-delta", index: 1, text: "\\n<agentroom-ques" }
    });
    event(sessionId, "assistant/chunk", {
      turn,
      step: 1,
      chunk: { type: "text-delta", index: 2, text: "tion>" + question.slice(0, 40) }
    });
    event(sessionId, "assistant/chunk", {
      turn,
      step: 1,
      chunk: { type: "text-delta", index: 3, text: question.slice(40) + "</agentroom-question>" }
    });
    if (options.dieAfterQuestion) {
      process.stderr.write("dsh: failed after asking\\n");
      process.exit(4);
    }
    if (options.idleBeforeQuestionTurnEnd) {
      status(sessionId, "idle");
      setTimeout(() => {
        event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
      }, 20);
      return;
    }
    if (!options.omitTurnEnd) {
      event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
    }
    status(sessionId, "idle");
    return;
  }

  if (options.delayContinuationCompletion && promptNumber > 1) {
    setTimeout(() => {
      event(sessionId, "assistant/chunk", {
        turn,
        step: 1,
        chunk: { type: "text-delta", index: 1, text: " continuation-finished" }
      });
      event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
      status(sessionId, "idle");
    }, 50);
    return;
  }

  event(sessionId, "tool/call", { turn, step: 1, callId: "call-" + turn, name: "bash", arguments: "{}" });
  event(sessionId, "tool/result", {
    turn,
    step: 1,
    message: {
      role: "user",
      source: { kind: "tool", callId: "call-" + turn },
      content: [{ type: "tool-result", toolCallId: "call-" + turn, content: [{ type: "text", text: "ok" }] }]
    }
  });
  event(sessionId, "assistant/chunk", { chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } });
  event(sessionId, "assistant/message", {
    turn,
    step: 1,
    message: { role: "assistant", content: [] },
    usage: { inputTokens: 10, outputTokens: 2 }
  });
  if (!options.omitTurnEnd) {
    event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
  }
  status(sessionId, "idle");
});
`, "utf8");
  return path;
}
