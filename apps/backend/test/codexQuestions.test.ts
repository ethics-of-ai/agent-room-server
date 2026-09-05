import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import { codexUserInputBatch, codexUserInputResponse } from "../src/runner/codex/userInput";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { MAX_QUESTION_PROMPT_LENGTH } from "../src/runner/shared/PendingQuestionRequests";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-codex-questions-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    codexRunnerProtocol: "jsonrpc",
    ...overrides
  } as ServiceConfig;
};

// The request shape codex-cli 0.149 sends, trimmed.
const REQUEST_PARAMS = {
  threadId: "codex-thread-1",
  turnId: "codex-turn-1",
  itemId: "call_ask1",
  questions: [
    {
      id: "platform",
      header: "Platform",
      question: "Which platform should the TODO app target?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Web (Recommended)", description: "Works in a browser." },
        { label: "Mobile", description: "iOS and Android." }
      ]
    },
    {
      id: "api_key",
      header: "API key",
      question: "Paste the API key to use.",
      isOther: true,
      isSecret: true,
      options: null
    }
  ],
  isBlocking: false,
  autoResolutionMs: null
};

function canonicalOf(events: AgentRunnerEvent[], kind: string): Array<Record<string, unknown>> {
  return events
    .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
    .map((event) => event.activity.canonical as Record<string, unknown> | undefined)
    .filter((canonical): canonical is Record<string, unknown> => canonical?.kind === kind);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Codex request_user_input mapping", () => {
  it("mints set and option ids, always invites free text, and marks a secret question sensitive", () => {
    const batch = codexUserInputBatch(REQUEST_PARAMS);
    if ("error" in batch) throw new Error(batch.error);
    expect(batch.sets).toEqual([
      {
        setId: "set-1",
        header: "Platform",
        prompt: "Which platform should the TODO app target?",
        selection: "single",
        options: [
          { optionId: "opt-1", label: "Web (Recommended)", description: "Works in a browser." },
          { optionId: "opt-2", label: "Mobile", description: "iOS and Android." }
        ],
        discussion: "optional"
      },
      {
        setId: "set-2",
        header: "API key",
        prompt: "Paste the API key to use.",
        selection: "single",
        options: [],
        discussion: "required",
        sensitive: true
      }
    ]);
  });

  it("writes answers back by the agent's question id as labels plus free text, omitting unanswered ids", () => {
    const batch = codexUserInputBatch(REQUEST_PARAMS);
    if ("error" in batch) throw new Error(batch.error);
    expect(
      codexUserInputResponse(batch, {
        status: "answered",
        decidedBy: "human",
        answers: [{ setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" }]
      })
    ).toEqual({ answers: { platform: { answers: ["Mobile", "phones first"] } } });
    expect(codexUserInputResponse(batch, { status: "timeout", decidedBy: "timeout" })).toEqual({ answers: {} });
    expect(codexUserInputResponse(batch, { status: "cancelled" })).toEqual({ answers: {} });
  });

  it("refuses model-authored text outside the shared bounds instead of truncating it", () => {
    const batch = codexUserInputBatch({
      ...REQUEST_PARAMS,
      questions: [{
        ...REQUEST_PARAMS.questions[0],
        question: "q".repeat(MAX_QUESTION_PROMPT_LENGTH + 1)
      }]
    });
    expect(batch).toEqual({ error: "request_user_input batch exceeds AgentRoom's question bounds" });
  });
});

describe("CodexAppServerRunner clarifying questions", () => {
  it("holds request_user_input open for a human answer, responds by question id, and keeps a secret off the stream", async () => {
    const fake = await writeAskingFakeServer("ask");
    const serviceConfig = await config({ codexArgs: [fake.path] });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "turn-q",
        sessionId: "session-q",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "decide for me"
      })) {
        events.push(event);
      }
    })();

    await waitFor(() => canonicalOf(events, "question_requested").length > 0);
    const requested = canonicalOf(events, "question_requested")[0];
    const requestId = requested.requestId as string;
    expect(requestId).toMatch(/^question-/);
    expect(requested.questionSets).toEqual([
      expect.objectContaining({ setId: "set-1", header: "Platform", discussion: "optional" }),
      expect.objectContaining({ setId: "set-2", sensitive: true, discussion: "required" })
    ]);

    expect(
      runner.answerQuestionRequest({
        sessionId: "session-q",
        requestId,
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" },
          { setId: "set-2", selectedOptionIds: [], discussion: "sk-very-secret" }
        ]
      })
    ).toBe("answered");
    await run;

    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "run_succeeded" }));
    const resolved = canonicalOf(events, "question_resolved")[0];
    expect(resolved).toEqual({
      kind: "question_resolved",
      requestId,
      status: "answered",
      decidedBy: "human",
      questionAnswers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" },
        // The secret reached the agent and nowhere else.
        { setId: "set-2", selectedOptionIds: [] }
      ]
    });
    expect(JSON.stringify(events)).not.toContain("sk-very-secret");

    const log = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const threadStart = log.find((entry) => entry.method === "thread/start");
    expect(threadStart.params.config).toMatchObject({
      tools: { experimental_request_user_input: { enabled: true } },
      features: { default_mode_request_user_input: true }
    });
    const response = log.find((entry) => entry.id === 100 && "result" in entry);
    expect(response.result).toEqual({
      answers: {
        platform: { answers: ["Mobile", "phones first"] },
        api_key: { answers: ["sk-very-secret"] }
      }
    });
    await runner.dispose();
  });

  it("answers nothing after the bounded wait and tells the agent so", async () => {
    const fake = await writeAskingFakeServer("ask");
    const serviceConfig = await config({ codexArgs: [fake.path] });
    const runner = new CodexAppServerRunner(serviceConfig, { questionTimeoutMs: 50 });
    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "turn-t",
      sessionId: "session-t",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "decide for me"
    })) {
      events.push(event);
    }
    expect(canonicalOf(events, "question_resolved")[0]).toMatchObject({ status: "timeout", decidedBy: "timeout" });
    const log = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(log.find((entry) => entry.id === 100 && "result" in entry).result).toEqual({ answers: {} });
    await runner.dispose();
  });

  it("refuses a server request it does not serve with method-not-found instead of hanging the turn", async () => {
    const fake = await writeAskingFakeServer("approval");
    const serviceConfig = await config({ codexArgs: [fake.path] });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "turn-a",
      sessionId: "session-a",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "run something"
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "run_succeeded" }));
    const log = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(log.find((entry) => entry.id === 101 && "error" in entry).error).toMatchObject({ code: -32601 });
    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    await runner.dispose();
  });

  it("pins request_user_input off and answers nothing if Codex still raises it while disabled", async () => {
    const fake = await writeAskingFakeServer("ask");
    const serviceConfig = await config({ codexArgs: [fake.path], clarifyingQuestionsEnabled: false });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];
    for await (const _event of runner.run({
      runId: "turn-d",
      sessionId: "session-d",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "go"
    })) {
      events.push(_event);
    }
    const log = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const threadStart = log.find((entry) => entry.method === "thread/start");
    expect(threadStart.params.config.tools).toEqual({ experimental_request_user_input: { enabled: false } });
    expect(threadStart.params.config.features).toEqual({ default_mode_request_user_input: false });
    expect(threadStart.params.config.sandbox_workspace_write).toEqual({ network_access: false });
    expect(log.find((entry) => entry.id === 100 && "result" in entry).result).toEqual({ answers: {} });
    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    await runner.dispose();
  });
});

/**
 * A fake app-server that, on `turn/start`, raises one server→client request
 * (`ask`: `item/tool/requestUserInput`; `approval`: an approval method the
 * runner does not serve; `none`: nothing) and completes the turn once the
 * client answers. Every inbound frame is appended to a log the test reads.
 */
async function writeAskingFakeServer(mode: "ask" | "approval" | "none"): Promise<{ path: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-asking-"));
  const path = join(root, "fake-codex-asking.cjs");
  const log = join(root, "frames.jsonl");
  await writeFile(path, `
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const LOG = ${JSON.stringify(log)};
const MODE = ${JSON.stringify(mode)};
const REQUEST = ${JSON.stringify(REQUEST_PARAMS)};
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function thread() { return { id: "codex-thread-1", sessionId: "codex-session-1", forkedFromId: null, preview: "", ephemeral: true, modelProvider: "openai", createdAt: 1, updatedAt: 1, status: "running", path: null, cwd: "/tmp/workspace", cliVersion: "fake", source: "appServer", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }; }
function turn(status) { return { id: "codex-turn-1", items: [], itemsView: "full", status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: status === "completed" ? 100 : null }; }
function complete() {
  send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", itemId: "assistant-message-1", delta: "noted" } });
  send({ method: "turn/completed", params: { threadId: "codex-thread-1", turn: turn("completed") } });
}
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(2); }
  fs.appendFileSync(LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", modelProvider: "openai", serviceTier: null, cwd: "/tmp/workspace", instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: { type: "readOnly", networkAccess: false }, permissionProfile: null, activePermissionProfile: null, reasoningEffort: null } });
    send({ method: "thread/started", params: { thread: thread() } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId: "codex-thread-1", turn: turn("inProgress") } });
    if (MODE === "ask") { send({ id: 100, method: "item/tool/requestUserInput", params: REQUEST }); return; }
    if (MODE === "approval") { send({ id: 101, method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread-1", turnId: "codex-turn-1", itemId: "cmd-1", command: "rm -rf /" } }); return; }
    complete();
    return;
  }
  if ((message.id === 100 || message.id === 101) && ("result" in message || "error" in message)) {
    send({ method: "serverRequest/resolved", params: { threadId: "codex-thread-1", requestId: message.id } });
    complete();
  }
});
`);
  await chmod(path, 0o755);
  return { path, log };
}
