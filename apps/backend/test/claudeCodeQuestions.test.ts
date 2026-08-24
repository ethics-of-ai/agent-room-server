import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import {
  HEADLESS_PERMISSION_DENY_MESSAGE,
  QUESTION_TIMEOUT_RESPONSE
} from "../src/runner/claudeCode/askUserQuestion";
import { AsyncEventQueue } from "../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeCanUseTool, ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-claude-questions-"));
  return {
    runnerKind: "claude_code",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

const ASK_INPUT = {
  questions: [
    {
      question: "Which platform first?",
      header: "Platform",
      options: [
        { label: "Web", description: "Browser" },
        { label: "Mobile", description: "Phones" }
      ],
      multiSelect: false
    },
    {
      question: "Which features?",
      header: "Features",
      options: [{ label: "Reminders" }, { label: "Tags" }, { label: "Sharing" }],
      multiSelect: true
    }
  ]
};

type CanUseToolResult = Awaited<ReturnType<ClaudeCodeCanUseTool>>;

/**
 * A fake SDK query that, on the first user message, emits the CLI's init and an
 * `AskUserQuestion` tool_use, then calls the `canUseTool` callback the way the
 * SDK does and completes the turn once it returns — so the round trip from the
 * SDK callback through the pending store to the answer hook is exercised
 * without a child process.
 */
class AskingClaudeQuery implements ClaudeCodeQuery {
  readonly output = new AsyncEventQueue<unknown>();
  readonly abort = new AbortController();
  readonly canUseToolResults: CanUseToolResult[] = [];
  interruptCalls = 0;
  returned = false;

  constructor(
    prompt: AsyncIterable<unknown>,
    readonly options: Record<string, unknown>,
    private readonly scenario: { toolName?: string; input?: Record<string, unknown> } = {}
  ) {
    void (async () => {
      let first = true;
      for await (const _message of prompt) {
        if (!first) continue;
        first = false;
        void this.askThenFinish();
      }
    })();
  }

  private async askThenFinish(): Promise<void> {
    const sessionId = "claude-session-q";
    const toolName = this.scenario.toolName ?? "AskUserQuestion";
    const input = this.scenario.input ?? ASK_INPUT;
    this.output.push({ type: "system", subtype: "init", session_id: sessionId, model: "m", cwd: "/w", uuid: "u0" });
    this.output.push({
      type: "assistant",
      session_id: sessionId,
      uuid: "u1",
      parent_tool_use_id: null,
      message: { role: "assistant", model: "m", content: [{ type: "tool_use", id: "toolu_q", name: toolName, input }] }
    });
    const canUseTool = this.options.canUseTool as ClaudeCodeCanUseTool | undefined;
    if (canUseTool) {
      const result = await canUseTool(toolName, input, { signal: this.abort.signal, toolUseID: "toolu_q" });
      this.canUseToolResults.push(result);
    }
    this.output.push({
      type: "user",
      session_id: sessionId,
      uuid: "u2",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", is_error: false }] }
    });
    this.output.push({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      uuid: "u3",
      result: "done",
      usage: { input_tokens: 1, output_tokens: 1 }
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    // The SDK aborts the callback's signal when the turn is interrupted.
    this.abort.abort();
  }

  async supportedModels(): Promise<unknown[]> {
    return [];
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.returned = true;
    this.output.close();
    return { value: undefined, done: true };
  }
}

function harness(scenario: { toolName?: string; input?: Record<string, unknown> } = {}): {
  loadQuery: () => Promise<ClaudeCodeQueryFunction>;
  queries: AskingClaudeQuery[];
} {
  const queries: AskingClaudeQuery[] = [];
  const queryFunction: ClaudeCodeQueryFunction = ({ prompt, options }) => {
    const query = new AskingClaudeQuery(prompt, options, scenario);
    queries.push(query);
    return query;
  };
  return { loadQuery: async () => queryFunction, queries };
}

function canonicalOf(events: AgentRunnerEvent[], kind: string): Array<Record<string, unknown>> {
  return events
    .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
    .map((event) => event.activity.canonical as Record<string, unknown> | undefined)
    .filter((canonical): canonical is Record<string, unknown> => canonical?.kind === kind);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ClaudeCodeRunner clarifying questions", () => {
  it("holds AskUserQuestion open for a human answer and writes it back as the tool's input", async () => {
    const serviceConfig = await config();
    const h = harness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: h.loadQuery });
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
      expect.objectContaining({ setId: "set-1", header: "Platform", selection: "single", discussion: "optional" }),
      expect.objectContaining({ setId: "set-2", header: "Features", selection: "multiple" })
    ]);

    // Wrong session, wrong set, wrong option, then the real answer.
    expect(runner.answerQuestionRequest({ sessionId: "other", requestId, answers: [] })).toBe("unknown_request");
    expect(
      runner.answerQuestionRequest({ sessionId: "session-q", requestId, answers: [{ setId: "set-9", selectedOptionIds: [] }] })
    ).toBe("unknown_set");
    expect(
      runner.answerQuestionRequest({
        sessionId: "session-q",
        requestId,
        answers: [{ setId: "set-1", selectedOptionIds: ["opt-1", "opt-2"] }]
      })
    ).toBe("selection_limit");
    expect(
      runner.answerQuestionRequest({
        sessionId: "session-q",
        requestId,
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" },
          { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        ]
      })
    ).toBe("answered");

    await run;
    expect(events.at(-1)).toEqual({ type: "run_succeeded", message: "done" });
    expect(canonicalOf(events, "question_resolved")[0]).toEqual({
      kind: "question_resolved",
      requestId,
      status: "answered",
      decidedBy: "human",
      questionAnswers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first" },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
      ]
    });
    expect(h.queries[0].canUseToolResults[0]).toEqual({
      behavior: "allow",
      updatedInput: {
        ...ASK_INPUT,
        answers: { "Which platform first?": "Mobile", "Which features?": "Reminders, Sharing" },
        annotations: { "Which platform first?": { notes: "phones first" } }
      }
    });
    // Settled, so a second answer has nothing to reach.
    expect(runner.answerQuestionRequest({ sessionId: "session-q", requestId, answers: [] })).toBe("unknown_request");
    await runner.dispose();
  });

  it("refuses every other tool with the CLI's own headless wording, so the posture is unchanged", async () => {
    const serviceConfig = await config();
    const h = harness({ toolName: "Write", input: { file_path: "/tmp/x", content: "hello" } });
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: h.loadQuery });
    const events: AgentRunnerEvent[] = [];
    for await (const event of runner.run({
      runId: "turn-w",
      sessionId: "session-w",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "write a file"
    })) {
      events.push(event);
    }
    expect(h.queries[0].canUseToolResults[0]).toEqual({ behavior: "deny", message: HEADLESS_PERMISSION_DENY_MESSAGE });
    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    await runner.dispose();
  });

  it("answers nothing after the bounded wait and tells the model why", async () => {
    const serviceConfig = await config();
    const h = harness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: h.loadQuery, questionTimeoutMs: 30 });
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
    expect(h.queries[0].canUseToolResults[0]).toEqual({
      behavior: "allow",
      updatedInput: { ...ASK_INPUT, answers: {}, response: QUESTION_TIMEOUT_RESPONSE }
    });
    await runner.dispose();
  });

  it("cancels the wait when the turn is interrupted", async () => {
    const serviceConfig = await config();
    const h = harness();
    const runner = new ClaudeCodeRunner(serviceConfig, { loadQuery: h.loadQuery });
    const events: AgentRunnerEvent[] = [];
    const run = (async () => {
      for await (const event of runner.run({
        runId: "turn-c",
        sessionId: "session-c",
        workspacePath: serviceConfig.workspaceRoot,
        prompt: "decide for me"
      })) {
        events.push(event);
      }
    })();
    await waitFor(() => canonicalOf(events, "question_requested").length > 0);
    await runner.cancel("turn-c");
    await run;
    await waitFor(() => h.queries[0].canUseToolResults.length > 0);
    expect(h.queries[0].canUseToolResults[0]).toEqual({ behavior: "deny", message: "Turn cancelled" });
    expect(events.at(-1)).toEqual({ type: "run_failed", error: "Claude Code turn interrupted" });
    await runner.dispose();
  });

  it("passes the callback only while the channel is enabled, and never to the capability probe", async () => {
    const enabled = await config();
    const enabledHarness = harness();
    // The scripted query asks and nobody answers here; a short clock keeps the
    // turn from waiting the full default.
    const enabledRunner = new ClaudeCodeRunner(enabled, { loadQuery: enabledHarness.loadQuery, questionTimeoutMs: 30 });
    await enabledRunner.getCapabilities();
    expect(enabledHarness.queries[0].options.canUseTool).toBeUndefined();
    for await (const _event of enabledRunner.run({
      runId: "turn-e",
      sessionId: "session-e",
      workspacePath: enabled.workspaceRoot,
      prompt: "go"
    })) {
      // drain
    }
    expect(typeof enabledHarness.queries[1].options.canUseTool).toBe("function");
    await enabledRunner.dispose();

    const disabled = await config({ clarifyingQuestionsEnabled: false });
    const disabledHarness = harness();
    const disabledRunner = new ClaudeCodeRunner(disabled, { loadQuery: disabledHarness.loadQuery });
    const events: AgentRunnerEvent[] = [];
    for await (const event of disabledRunner.run({
      runId: "turn-d",
      sessionId: "session-d",
      workspacePath: disabled.workspaceRoot,
      prompt: "go"
    })) {
      events.push(event);
    }
    expect(disabledHarness.queries[0].options.canUseTool).toBeUndefined();
    expect(canonicalOf(events, "question_requested")).toHaveLength(0);
    await disabledRunner.dispose();
  });
});
