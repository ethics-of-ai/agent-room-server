import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { CursorSdkRunner } from "../src/runner/cursor/CursorSdkRunner";
import { fallbackCursorCapabilities } from "../src/runner/cursor/capabilities";
import { buildServer } from "../src/server";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-cursor-"));
  return {
    runnerKind: "cursor",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  } as ServiceConfig;
};

const collect = async (events: AsyncIterable<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> => {
  const collected: AgentRunnerEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
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

describe("CursorSdkRunner", () => {
  it("starts a host, streams the run, and settles on the run result", async () => {
    const host = await writeFakeHost();
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello Cursor"
    }));
    await runner.dispose();

    expect(events).toContainEqual({
      type: "agent_activity",
      activity: expect.objectContaining({
        kind: "cursor_session_started",
        canonical: { kind: "session_started" },
        runner: expect.objectContaining({ nativeSessionId: "agent-fake-1" })
      })
    });
    expect(canonicalOf(events, "turn_started")).toHaveLength(1);
    expect(assistantText(events)).toContain("cwd=" + serviceConfig.workspaceRoot);
    expect(assistantText(events)).toContain("model=default");
    expect(events.map((event) => (event.type === "agent_activity" ? event.activity.canonical?.kind : undefined)))
      .toContain("tool_started");
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "final answer" });
    expect(events.at(-2)).toMatchObject({
      type: "runner_audit",
      audit: { phase: "completed", runnerKind: "cursor", status: "succeeded", command: { executableName: "node", argsCount: 1 } }
    });
  });

  it("maps a turn's effort and speed onto the parameters the live catalog declares", async () => {
    const host = await writeFakeHost();
    const serviceConfig = await config({ cursorReasoningEffort: "low" });
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    // The fake host's `models/list` declares `effort` and `fast` on Claude Opus
    // 5, so the turn's selection rides those names on both start and send.
    const events = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello",
      settings: { model: "claude-opus-5", reasoningEffort: "high", serviceTier: "fast" }
    }));
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "final answer" });
    expect(assistantText(events)).toContain('model=claude-opus-5');
    expect(assistantText(events)).toContain('startParams=[{"id":"effort","value":"high"},{"id":"fast","value":"true"}]');
    expect(assistantText(events)).toContain('sendParams=[{"id":"effort","value":"high"},{"id":"fast","value":"true"}]');

    // The operator's configured effort applies only where the model offers it:
    // Composer declares speed but no depth, so a second turn on it runs with no
    // depth parameter rather than failing.
    const composer = await collect(runner.run({
      runId: "agentroom-turn-2",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Again",
      settings: { model: "composer-2.5" }
    }));
    expect(composer.at(-1)).toEqual({ type: "run_succeeded", message: "final answer" });
    expect(assistantText(composer)).toContain("sendParams=[]");
    const composerTurnStarted = composer.find(
      (event) => event.type === "agent_activity" && event.activity.canonical?.kind === "turn_started"
    );
    expect(composerTurnStarted).toMatchObject({
      activity: { runner: { model: "composer-2.5", nativeTurnId: "run-2" } }
    });

    // A turn's own selection the model does not offer is refused before send.
    const refused = await collect(runner.run({
      runId: "agentroom-turn-3",
      sessionId: "agent-session-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Once more",
      settings: { model: "composer-2.5", reasoningEffort: "high" }
    }));
    expect(refused.at(-1)).toEqual({
      type: "run_failed",
      error: 'Cursor model "composer-2.5" does not offer the reasoning effort "high"'
    });
    await runner.dispose();
  });

  it("holds a question open, accepts the answer over the HTTP route, and resumes the turn", async () => {
    const host = await writeFakeHost({ askQuestion: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });
    const { app, eventBus } = await buildServer({ config: serviceConfig, runners: { cursor: runner } });
    const workspace = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: serviceConfig.workspaceRoot } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: workspace.json().workspace.id, runnerKind: "cursor" }
    });
    const sessionId = session.json().session.id as string;
    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "Which client first?" }
    });
    expect(turn.statusCode).toBe(202);

    await waitFor(() => eventBus.getRecentEvents().some((event) => event.type === "coding_question_requested"));
    const requested = eventBus.getRecentEvents().find((event) => event.type === "coding_question_requested");
    if (!requested || requested.type !== "coding_question_requested") throw new Error("Missing question request");
    const requestId = requested.payload.requestId;
    expect(requested.payload.questionSets).toEqual([
      expect.objectContaining({ setId: "set-1", header: "Target", selection: "single", discussion: "optional" }),
      expect.objectContaining({ setId: "set-2", header: "Secret", discussion: "required", sensitive: true })
    ]);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${requestId}`,
      payload: {
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "It has the broader operator workflow." },
          { setId: "set-2", selectedOptionIds: [], discussion: "temporary-secret-note" }
        ]
      }
    });
    expect(answered.statusCode).toBe(200);
    await waitFor(() => eventBus.getRecentEvents().some((event) => event.type === "coding_turn_completed"));

    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(detail.json().session.status).toBe("idle");
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json().messages.some(
      (message: { role: string; content: string }) => message.role === "assistant" && message.content.includes("chose: macOS")
    )).toBe(true);
    expect(JSON.stringify(messages.json())).toContain("It has the broader operator workflow.");
    expect(JSON.stringify(messages.json())).not.toContain("temporary-secret-note");

    const resolved = eventBus.getRecentEvents().find((event) => event.type === "coding_question_resolved");
    if (!resolved || resolved.type !== "coding_question_resolved") throw new Error("Missing question resolution");
    expect(resolved.payload.questionAnswers).toEqual([
      { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "It has the broader operator workflow." },
      { setId: "set-2", selectedOptionIds: [] }
    ]);
    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    expect(JSON.stringify(audit.json())).not.toContain("temporary-secret-note");

    await app.close();
  });

  it("continues without inventing an answer when a question times out", async () => {
    const host = await writeFakeHost({ askQuestion: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host, questionTimeoutMs: 40 });
    const events = await collect(runner.run({
      runId: "agentroom-turn-timeout",
      sessionId: "agent-session-timeout",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Which client first?"
    }));
    await runner.dispose();

    expect(canonicalOf(events, "question_resolved")[0]).toMatchObject({ status: "timeout", decidedBy: "timeout" });
    expect(assistantText(events)).toContain("chose: (timeout)");
    expect(events.at(-1)).toMatchObject({ type: "run_succeeded" });
  });

  it("leaves no question channel when clarifying questions are disabled", async () => {
    const host = await writeFakeHost({ askQuestion: true });
    const serviceConfig = await config({ clarifyingQuestionsEnabled: false });
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });
    const events = await collect(runner.run({
      runId: "agentroom-turn-disabled",
      sessionId: "agent-session-disabled",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Which client first?"
    }));
    await runner.dispose();

    // The host was told not to register the tool, so it never asks.
    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    expect(assistantText(events)).toContain("no question tool");
    expect(events.at(-1)).toMatchObject({ type: "run_succeeded" });
  });

  it("cancels a hung run by killing the host, and the turn ends interrupted", async () => {
    const host = await writeFakeHost({ hangAfterSend: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const collected: AgentRunnerEvent[] = [];
    const run = runner.run({
      runId: "agentroom-turn-cancel",
      sessionId: "agent-session-cancel",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "HANG please"
    });
    for await (const event of run) {
      collected.push(event);
      if (event.type === "agent_update") await runner.cancel("agentroom-turn-cancel");
    }
    await runner.dispose();

    expect(collected.at(-1)).toMatchObject({ type: "run_failed", error: expect.stringContaining("interrupted") });
  });

  it("resumes a reaped session's agent in a fresh host on the next turn", async () => {
    const host = await writeFakeHost();
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host, idleSessionTimeoutMs: 40 });

    const first = await collect(runner.run({
      runId: "agentroom-turn-1",
      sessionId: "agent-session-resume",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "first"
    }));
    expect(first.at(-1)).toMatchObject({ type: "run_succeeded" });
    // Let the idle timer reap the session's host child.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const second = await collect(runner.run({
      runId: "agentroom-turn-2",
      sessionId: "agent-session-resume",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "second"
    }));
    await runner.dispose();

    // A fresh host spawned with the kept agent id reports a resume.
    expect(assistantText(second)).toContain("resumed=true");
    expect(second.at(-1)).toMatchObject({ type: "run_succeeded" });
  });

  it("fails the turn with the host's own stderr when the child dies on send", async () => {
    const host = await writeFakeHost({ dieOnSend: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const events = await collect(runner.run({
      runId: "agentroom-turn-die",
      sessionId: "agent-session-die",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.dispose();

    expect(events.at(-1)).toMatchObject({ type: "run_failed" });
  });

  it("forces the first send after a host crash so a persisted active run cannot wedge resume", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "agentroom-cursor-crash-marker-"));
    const marker = join(markerRoot, "crashed");
    const host = await writeFakeHost({ dieOnceMarkerPath: marker });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const first = await collect(runner.run({
      runId: "agentroom-turn-crash-1",
      sessionId: "agent-session-crash",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "crash once"
    }));
    expect(first.at(-1)).toMatchObject({ type: "run_failed" });

    const recovered = await collect(runner.run({
      runId: "agentroom-turn-crash-2",
      sessionId: "agent-session-crash",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "recover"
    }));
    await runner.dispose();

    expect(assistantText(recovered)).toContain("resumed=true");
    expect(assistantText(recovered)).toContain("force=true");
    expect(recovered.at(-1)).toMatchObject({ type: "run_succeeded" });
  });

  it("proves readiness through the model list and keeps an operator model", async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), "agentroom-cursor-shutdown-marker-"));
    const shutdownMarker = join(markerRoot, "shutdown");
    const host = await writeFakeHost({ shutdownMarkerPath: shutdownMarker });
    const serviceConfig = await config({ cursorModel: "composer-2.5" });
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const capabilities = await runner.getCapabilities();
    await runner.dispose();

    expect(capabilities.error).toBeUndefined();
    const ids = capabilities.settings.models.map((model) => model.id);
    expect(ids).toContain("composer-2.5");
    expect(ids).toContain("claude-opus-5");
    expect(capabilities.settings.defaultSettings.model).toBe("composer-2.5");
    expect(await readFile(shutdownMarker, "utf8")).toBe("shutdown");
  });

  it("rejects malformed initialize results in discovery and session startup", async () => {
    const host = await writeFakeHost({ malformedInitialize: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const capabilities = await runner.getCapabilities();
    expect(capabilities.error).toBeTruthy();

    const events = await collect(runner.run({
      runId: "agentroom-turn-malformed-init",
      sessionId: "agent-session-malformed-init",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Hello"
    }));
    await runner.dispose();
    expect(events.at(-1)).toMatchObject({ type: "run_failed", error: expect.stringContaining("sdkVersion") });
  });

  it("reports a host it cannot initialize as unready rather than an empty catalog", async () => {
    const host = await writeFakeHost({ rejectInitialize: true });
    const serviceConfig = await config();
    const runner = new CursorSdkRunner(serviceConfig, { hostModulePath: host });

    const capabilities = await runner.getCapabilities();
    await runner.dispose();

    expect(capabilities.runnerKind).toBe("cursor");
    expect(capabilities.error).toBeTruthy();
    expect(capabilities.settings.models.length).toBeGreaterThan(0);
  });
});

describe("Cursor fallback catalog", () => {
  it("advertises each model's own depth and speed vocabulary, never a borrowed one", () => {
    const models = fallbackCursorCapabilities({} as ServiceConfig).settings.models;
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("default")).toMatchObject({ isDefault: true, reasoningEfforts: [], serviceTiers: [] });
    expect(byId.get("composer-2.5")?.reasoningEfforts).toEqual([]);
    expect(byId.get("composer-2.5")?.serviceTiers.map((tier) => tier.id)).toEqual(["standard", "fast"]);
    expect(byId.get("claude-opus-5")?.reasoningEfforts.map((effort) => effort.id))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byId.get("gpt-5.3-codex")?.reasoningEfforts.map((effort) => effort.id))
      .toEqual(["low", "medium", "high", "extra-high"]);
    expect(byId.get("claude-sonnet-5")?.serviceTiers).toEqual([]);
  });

  it("reports the catalog's own default when nothing is configured", () => {
    expect(fallbackCursorCapabilities({} as ServiceConfig).settings.defaultSettings).toEqual({ model: "default" });
  });
});

/**
 * A stand-in for the compiled Cursor SDK host: it speaks the same
 * newline-delimited JSON-RPC and emits the same run stream, which is the whole
 * contract the adapter depends on. It never imports `@cursor/sdk`.
 */
async function writeFakeHost(options: {
  askQuestion?: boolean;
  hangAfterSend?: boolean;
  dieOnSend?: boolean;
  dieOnceMarkerPath?: string;
  rejectInitialize?: boolean;
  malformedInitialize?: boolean;
  shutdownMarkerPath?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-cursor-host-"));
  const path = join(root, "fake-cursor-host.cjs");
  await writeFile(path, `
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const options = ${JSON.stringify(options)};
let cwd, model, sendModel, agentId, resumed, questionTool, sendForce;
let nextRunId = 0;
let nextRequestId = 0;
const pending = new Map();

function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function message(runId, msg) { notify("run/message", { runId, message: msg }); }
function backendRequest(method, params) {
  return new Promise((resolve) => { const id = "h" + nextRequestId++; pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}

async function runTurn(runId) {
  message(runId, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "session=" + agentId + " cwd=" + cwd + " model=" + model.id + " resumed=" + resumed + " force=" + sendForce + " startParams=" + JSON.stringify(model.params || []) + " sendParams=" + JSON.stringify((sendModel && sendModel.params) || []) } ] } });
  message(runId, { type: "tool_call", call_id: "call-1", name: "shell", status: "running", args: { command: "ls" } });
  message(runId, { type: "tool_call", call_id: "call-1", name: "shell", status: "completed", result: "ok" });

  if (options.hangAfterSend) return; // never settles; the adapter must cancel and kill.

  if (options.askQuestion) {
    if (questionTool) {
      const answer = await backendRequest("question/ask", { input: { questions: [
        { header: "Target", question: "Which client first?", selection: "single", options: [ { label: "visionOS" }, { label: "macOS" } ], discussion: "optional" },
        { header: "Secret", question: "Add a private note", selection: "single", options: [], discussion: "required", sensitive: true }
      ] } });
      const text = (answer && answer.result) || "";
      const chose = text.includes("macOS") ? "macOS" : text.includes("away") || text.includes("time") ? "(timeout)" : "unknown";
      message(runId, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "chose: " + chose }] } });
    } else {
      message(runId, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no question tool" }] } });
    }
  }

  message(runId, { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, totalTokens: 12 } });
  notify("run/result", { runId, status: "finished", result: "final answer", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
}

rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // Response to our own question/ask request.
  if (msg.id !== undefined && msg.method === undefined && (("result" in msg) || ("error" in msg))) {
    const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); resolve(msg.result); } return;
  }
  const respond = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      if (options.rejectInitialize) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "not signed in" } }); return; }
      if (options.malformedInitialize) { respond({ sdkVersion: 12 }); return; }
      respond({ sdkVersion: "fake-1.0.0" }); return;
    case "agent/start":
      cwd = msg.params.cwd; model = msg.params.model; questionTool = msg.params.questionTool;
      agentId = msg.params.agentId || "agent-fake-1"; resumed = Boolean(msg.params.agentId);
      respond({ agentId, resumed }); return;
    case "agent/send":
      if (options.dieOnSend) { process.stderr.write("cursor host: sign-in expired\\n"); process.exit(3); }
      if (options.dieOnceMarkerPath && !fs.existsSync(options.dieOnceMarkerPath)) {
        fs.writeFileSync(options.dieOnceMarkerPath, "crashed");
        process.stderr.write("cursor host: crashed with an active run\\n");
        process.exit(3);
      }
      { sendModel = msg.params.model; sendForce = Boolean(msg.params.force); const runId = "run-" + (++nextRunId); respond({ runId }); void runTurn(runId); } return;
    case "run/cancel":
      // A hung run is never settled here; the adapter's ladder kills the child.
      respond({}); return;
    case "models/list":
      respond({ models: [
        { id: "default", displayName: "Auto", parameters: [], variants: [{ isDefault: true, params: [] }] },
        { id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }], variants: [{ isDefault: true, params: [{ id: "fast", value: "true" }] }] },
        { id: "claude-opus-5", displayName: "Claude Opus 5", parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }, { id: "fast", values: [{ value: "false" }, { value: "true" }] }], variants: [{ isDefault: true, params: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }] }] }
      ] }); return;
    case "shutdown":
      if (options.shutdownMarkerPath) fs.writeFileSync(options.shutdownMarkerPath, "shutdown");
      respond({}); setImmediate(() => process.exit(0)); return;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } }); return;
  }
});
`, "utf8");
  return path;
}
