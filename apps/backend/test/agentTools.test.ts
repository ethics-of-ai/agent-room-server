import { afterEach, describe, expect, it } from "vitest";
import {
  agentToolByLogicalId,
  agentToolByName,
  allAgentTools,
  allowedAgentToolLogicalIds,
  registerAgentTool,
  unregisterAgentTool,
  type AgentToolDefinition
} from "../src/agentTools/catalog";
import {
  bindAgentTools,
  MAX_AGENT_TOOL_RESULT_CHARS,
  type AgentToolCallTelemetry
} from "../src/agentTools/dispatch";
import {
  QUESTIONS_ASK_INPUT_SCHEMA,
  QUESTIONS_ASK_LOGICAL_ID,
  QUESTIONS_ASK_NAME,
  questionsAskDefinition
} from "../src/agentTools/questionAsk";
import { cursorQuestionBatch } from "../src/runner/cursor/questions";
import {
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_SETS
} from "../src/runner/shared/PendingQuestionRequests";

/**
 * B04's reusable tool catalog and bound dispatch. Two properties matter most
 * here: registering another definition plus an injected handler crosses the
 * same single binding surface (no per-tool callback or boolean anywhere), and
 * telemetry carries safe metadata only — never a tool's arguments or results.
 */

const cleanupLogicalIds: string[] = [];

function registerTestTool(overrides: Partial<AgentToolDefinition> = {}): AgentToolDefinition {
  const definition: AgentToolDefinition = {
    logicalId: "test.demo",
    name: "test_demo",
    description: "A test-only tool.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    outputSchema: { type: "string" },
    unavailableResult: "The demo tool is unavailable right now.",
    requiredCapability: "questions",
    ...overrides
  };
  registerAgentTool(definition);
  cleanupLogicalIds.push(definition.logicalId);
  return definition;
}

afterEach(() => {
  while (cleanupLogicalIds.length > 0) unregisterAgentTool(cleanupLogicalIds.pop() as string);
});

function turnHandle(overrides: { live?: boolean } = {}) {
  let live = overrides.live ?? true;
  return {
    handle: {
      sessionKey: "session-1",
      runId: "turn-1",
      isLive: () => live
    },
    setLive: (value: boolean) => {
      live = value;
    }
  };
}

function recorder() {
  const calls: AgentToolCallTelemetry[] = [];
  return { calls, onCall: (telemetry: AgentToolCallTelemetry) => calls.push(telemetry) };
}

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("AgentRoom tool catalog", () => {
  it("registers questions.ask at load with its native name and vocabulary bounds", () => {
    const definition = agentToolByLogicalId(QUESTIONS_ASK_LOGICAL_ID);
    expect(definition).toBe(questionsAskDefinition);
    expect(definition?.name).toBe("ask_user_question");
    expect(agentToolByName("ask_user_question")).toBe(definition);
    expect(agentToolByName(QUESTIONS_ASK_LOGICAL_ID)).toBe(definition);
    expect(allAgentTools()).toContain(definition);
  });

  it("composes an allowed set from the gates a turn satisfies", () => {
    // The question tool rides its clarifying-questions gate; a gateless tool
    // rides any turn. Question availability never implies another tool's.
    registerTestTool();
    expect(allowedAgentToolLogicalIds({
      gates: { clarifyingQuestions: true },
      capabilities: ["questions"]
    })).toEqual([
      QUESTIONS_ASK_LOGICAL_ID,
      "test.demo"
    ]);
    expect(allowedAgentToolLogicalIds({
      gates: { clarifyingQuestions: false },
      capabilities: ["questions"]
    })).toEqual(["test.demo"]);
    expect(allowedAgentToolLogicalIds({ gates: {}, capabilities: [] }))
      .toEqual([]);
  });

  it("refuses a colliding logical id or model-facing name", () => {
    registerTestTool();
    expect(() => registerTestTool({ name: "another_name" })).toThrow(/already registered/);
    expect(() => registerTestTool({ logicalId: "test.other" })).toThrow(/already registered/);
    expect(() => registerAgentTool({ ...questionsAskDefinition, name: "fresh_name" })).toThrow(
      /logical id "questions.ask" is already registered/
    );
  });

  it("unregisters a definition and frees its name", () => {
    registerTestTool();
    unregisterAgentTool("test.demo");
    expect(agentToolByLogicalId("test.demo")).toBeUndefined();
    expect(() => registerTestTool({ logicalId: "test.other" })).not.toThrow();
  });
});

describe("AgentRoom tool binding", () => {
  it("demonstrates the recipe: another definition and injected handler, same single surface", async () => {
    // Registering a second tool is one definition plus one handler entry in
    // the same bindAgentTools call. Nothing here knows "demo" specifically —
    // no second callback, no per-tool boolean, no relay change.
    const demo = registerTestTool();
    const seenInputs: unknown[] = [];
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [QUESTIONS_ASK_LOGICAL_ID, demo.logicalId],
      handlers: {
        [QUESTIONS_ASK_LOGICAL_ID]: async () => "question tool stood in",
        [demo.logicalId]: async (input) => {
          seenInputs.push(input);
          return `demo saw ${(input as { value: string }).value}`;
        }
      },
      turn: turnHandle().handle,
      options: { onCall }
    });

    expect(binding.advertisements().map((advertisement) => advertisement.name)).toEqual([
      QUESTIONS_ASK_NAME,
      "test_demo"
    ]);
    // Serializable definitions only: no handler, no unavailable text, no gate.
    expect(binding.advertisements()[1]).toEqual({
      name: "test_demo",
      description: "A test-only tool.",
      inputSchema: demo.inputSchema,
      outputSchema: demo.outputSchema
    });
    await expect(binding.invoke("test_demo", { value: "hello" })).resolves.toBe("demo saw hello");
    expect(seenInputs).toEqual([{ value: "hello" }]);
    expect(calls.map((call) => [call.logicalId, call.outcome])).toEqual([["test.demo", "completed"]]);
  });

  it("answers an unknown or unbound tool with a bounded refusal, calling nothing", async () => {
    let questionCalls = 0;
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [QUESTIONS_ASK_LOGICAL_ID],
      handlers: {
        [QUESTIONS_ASK_LOGICAL_ID]: async () => {
          questionCalls += 1;
          return "unused";
        }
      },
      turn: turnHandle().handle,
      options: { onCall }
    });

    // "test.demo" is registered (below) but not bound to this turn.
    registerTestTool();
    const result = await binding.invoke("test_demo", {});
    expect(result).toContain('"test_demo" is not available in this session');
    expect(result.length).toBeLessThan(400);
    await expect(binding.invoke("not_a_tool_at_all", { x: 1 })).resolves.toContain("not_a_tool_at_all");
    expect(questionCalls).toBe(0);
    expect(calls.map((call) => call.outcome)).toEqual(["unknown_tool", "unknown_tool"]);
  });

  it("refuses on a dead binding without running the handler", async () => {
    const demo = registerTestTool();
    let handlerCalls = 0;
    const { calls, onCall } = recorder();
    const turn = turnHandle();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: {
        [demo.logicalId]: async () => {
          handlerCalls += 1;
          return "ran";
        }
      },
      turn: turn.handle,
      options: { onCall }
    });

    turn.setLive(false);
    await expect(binding.invoke("test_demo", {})).resolves.toBe(demo.unavailableResult);
    turn.setLive(true);
    binding.dispose();
    await expect(binding.invoke("test_demo", {})).resolves.toBe(demo.unavailableResult);
    expect(handlerCalls).toBe(0);
    expect(calls.map((call) => call.outcome)).toEqual(["unavailable", "unavailable"]);
  });

  it("settles a thrown handler, a malformed result, and an oversized result safely", async () => {
    const demo = registerTestTool({ logicalId: "test.demo", name: "test_demo" });
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: {
        [demo.logicalId]: async (input) => {
          const mode = (input as { mode: string }).mode;
          if (mode === "throw") throw new Error("handler blew up reading token: hunter2-value");
          if (mode === "malformed") return 42 as unknown as string;
          return "x".repeat(MAX_AGENT_TOOL_RESULT_CHARS + 10);
        }
      },
      turn: turnHandle().handle,
      options: { onCall }
    });

    const thrown = await binding.invoke("test_demo", { mode: "throw" });
    expect(thrown).toContain("could not complete its work");
    expect(thrown).not.toContain("hunter2-value");
    expect(calls[0].outcome).toBe("handler_error");
    // The telemetry error is redacted in place: labelled secrets collapse to
    // the marker while the diagnostic words survive.
    expect(calls[0].error).toContain("token=[REDACTED]");
    expect(calls[0].error).not.toContain("hunter2-value");

    await expect(binding.invoke("test_demo", { mode: "malformed" })).resolves.toContain(
      "returned a result it could not present"
    );
    expect(calls[1].outcome).toBe("malformed_result");

    const oversized = await binding.invoke("test_demo", { mode: "big" });
    expect(oversized.length).toBe(MAX_AGENT_TOOL_RESULT_CHARS + "\n…(result truncated)".length);
    expect(oversized.endsWith("…(result truncated)")).toBe(true);
    expect(calls[2].outcome).toBe("truncated");
  });

  it("discards a late result after disposal, answering with the unavailable text", async () => {
    const demo = registerTestTool();
    const gate = deferred<string>();
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: { [demo.logicalId]: async () => gate.promise },
      turn: turnHandle().handle,
      options: { onCall }
    });

    const pending = binding.invoke("test_demo", {});
    binding.dispose();
    gate.resolve("settled after the turn ended");
    // The waiting transport still receives an answer, but the settled result
    // is discarded: it belongs to a turn that is over, so the tool's
    // unavailable text is what stays true for whichever turn reads it.
    await expect(pending).resolves.toBe(demo.unavailableResult);
    expect(calls[0].outcome).toBe("unavailable");
    expect(calls[0].late).toBe(true);
  });

  it("discards a result that settles after the turn switched, not just after dispose", async () => {
    const demo = registerTestTool();
    const gate = deferred<string>();
    const { calls, onCall } = recorder();
    const turn = turnHandle();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: { [demo.logicalId]: async () => gate.promise },
      turn: turn.handle,
      options: { onCall }
    });

    const pending = binding.invoke("test_demo", {});
    turn.setLive(false);
    gate.resolve("settled after the turn switched");
    await expect(pending).resolves.toBe(demo.unavailableResult);
    expect(calls[0].outcome).toBe("unavailable");
    expect(calls[0].late).toBe(true);
  });

  it("settles overlapping and repeated calls independently with distinct correlation ids", async () => {
    const demo = registerTestTool();
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let opened = 0;
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: {
        [demo.logicalId]: async () => gates[opened++].promise
      },
      turn: turnHandle().handle,
      options: { onCall }
    });

    const first = binding.invoke("test_demo", { call: 1 });
    const second = binding.invoke("test_demo", { call: 2 });
    gates[1].resolve("second settled first");
    await expect(second).resolves.toBe("second settled first");
    gates[0].resolve("first settled");
    await expect(first).resolves.toBe("first settled");
    // A repeated call after both settled still dispatches on the live binding.
    gates[2].resolve("third settled last");
    await expect(binding.invoke("test_demo", { call: 3 })).resolves.toBe("third settled last");

    const callIds = calls.map((call) => call.callId);
    expect(new Set(callIds).size).toBe(3);
    expect(calls.every((call) => call.outcome === "completed")).toBe(true);
  });

  it("keeps telemetry to safe metadata: no arguments, no results", async () => {
    const demo = registerTestTool();
    const { calls, onCall } = recorder();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: { [demo.logicalId]: async () => "result-with-sensitive-token" },
      turn: turnHandle().handle,
      options: { onCall }
    });
    await binding.invoke("test_demo", { secret: "argument-secret-token" });

    const recorded = JSON.stringify(calls);
    expect(recorded).not.toContain("argument-secret-token");
    expect(recorded).not.toContain("result-with-sensitive-token");
    expect(calls[0]).toMatchObject({
      logicalId: "test.demo",
      name: "test_demo",
      outcome: "completed"
    });
    expect(typeof calls[0].durationMs).toBe("number");
  });

  it("refuses to bind an unregistered logical id or a tool without a handler", () => {
    expect(() =>
      bindAgentTools({
        allowed: ["test.missing"],
        handlers: { "test.missing": async () => "unreachable" },
        turn: turnHandle().handle
      })
    ).toThrow(/Cannot bind unregistered AgentRoom tool "test.missing"/);

    const demo = registerTestTool();
    expect(() =>
      bindAgentTools({
        allowed: [demo.logicalId],
        handlers: {},
        turn: turnHandle().handle
      })
    ).toThrow(/No handler injected for AgentRoom tool "test.demo"/);
  });

  it("never shortens a handler's own wait: dispatch imposes no timeout", async () => {
    // A handler that waits past any plausible generic bound still settles with
    // its own result — the question channel's ten-minute human wait rides this.
    const demo = registerTestTool();
    const gate = deferred<string>();
    const binding = bindAgentTools({
      allowed: [demo.logicalId],
      handlers: { [demo.logicalId]: async () => gate.promise },
      turn: turnHandle().handle
    });
    const pending = binding.invoke("test_demo", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve("waited it out");
    await expect(pending).resolves.toBe("waited it out");
  });
});

describe("advertised question schema parity", () => {
  /**
   * A JSON-Schema evaluator for the subset the catalog advertises. Parity is
   * directional and that direction matters: everything the canonical mapping
   * (`cursorQuestionBatch`) accepts must be expressible under the advertised
   * schema — otherwise the model is offered a tool it cannot validly call —
   * while the schema's declared bounds must equal the vocabulary's constants
   * so neither can drift.
   */
  function schemaAccepts(schema: unknown, value: unknown): boolean {
    if (schema === null || typeof schema !== "object") return true;
    const node = schema as Record<string, unknown>;
    if (Array.isArray(node.enum)) return node.enum.includes(value);
    switch (node.type) {
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        for (const key of ((node.required as string[] | undefined) ?? [])) {
          if (!(key in record)) return false;
        }
        const properties = (node.properties ?? {}) as Record<string, unknown>;
        for (const [key, property] of Object.entries(properties)) {
          if (key in record && !schemaAccepts(property, record[key])) return false;
        }
        return true;
      }
      case "array": {
        if (!Array.isArray(value)) return false;
        if (typeof node.minItems === "number" && value.length < node.minItems) return false;
        if (typeof node.maxItems === "number" && value.length > node.maxItems) return false;
        return node.items === undefined || value.every((item) => schemaAccepts(node.items, item));
      }
      case "string":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      default:
        return true;
    }
  }

  const validQuestion = (overrides: Record<string, unknown> = {}) => ({
    question: "Which client first?",
    selection: "single",
    options: [{ label: "visionOS" }, { label: "macOS" }],
    discussion: "optional",
    ...overrides
  });

  it("declares exactly the vocabulary's numeric bounds", () => {
    const questions = (QUESTIONS_ASK_INPUT_SCHEMA.properties as Record<string, unknown>).questions as Record<string, unknown>;
    expect(questions.maxItems).toBe(MAX_QUESTION_SETS);
    expect(questions.minItems).toBe(1);
    const set = (questions.items as { properties: Record<string, unknown> }).properties;
    expect((set.options as Record<string, unknown>).maxItems).toBe(MAX_QUESTION_OPTIONS);
    expect(QUESTIONS_ASK_NAME).toBe("ask_user_question");
  });

  it("accepts every input the canonical mapping accepts", () => {
    const corpus = [
      { questions: [validQuestion()] },
      {
        questions: [
          validQuestion({ header: "Targets", selection: "multiple", discussion: "none" }),
          validQuestion({ question: "Paste the value", options: [], discussion: "required", sensitive: true })
        ]
      },
      {
        questions: Array.from({ length: MAX_QUESTION_SETS }, (_, index) =>
          validQuestion({
            question: `Question ${index + 1}`,
            options: Array.from({ length: MAX_QUESTION_OPTIONS }, (_, option) => ({ label: `O${option}` }))
          })
        )
      }
    ];
    for (const input of corpus) {
      const batch = cursorQuestionBatch(input);
      if ("error" in batch) throw new Error(`Corpus input refused by the mapper: ${batch.error}`);
      expect(schemaAccepts(QUESTIONS_ASK_INPUT_SCHEMA, input)).toBe(true);
    }
  });

  it("refuses, structurally, what the mapper also refuses", () => {
    const corpus = [
      {},
      { questions: [] },
      { questions: [{ selection: "single", options: [], discussion: "none" }] },
      { questions: [validQuestion({ selection: "both" })] },
      { questions: [validQuestion({ discussion: "sometimes" })] },
      { questions: [validQuestion({ options: [{ description: "no label" }] })] },
      {
        questions: Array.from({ length: MAX_QUESTION_SETS + 1 }, (_, index) =>
          validQuestion({ question: `Question ${index + 1}` })
        )
      },
      {
        questions: [
          validQuestion({
            options: Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, (_, option) => ({ label: `O${option}` }))
          })
        ]
      }
    ];
    for (const input of corpus) {
      expect(schemaAccepts(QUESTIONS_ASK_INPUT_SCHEMA, input)).toBe(false);
      expect("error" in cursorQuestionBatch(input)).toBe(true);
    }
  });
});
