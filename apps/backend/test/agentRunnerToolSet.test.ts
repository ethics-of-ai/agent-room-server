import { afterEach, describe, expect, it } from "vitest";
import { registerAgentTool, unregisterAgentTool } from "../src/agentTools/catalog";
import { prepareAgentRunnerToolSet } from "../src/agentTools/runnerToolSet";

const logicalId = "test.runner_input";

afterEach(() => unregisterAgentTool(logicalId));

function registerFixture(): void {
  registerAgentTool({
    logicalId,
    name: "test_runner_input",
    description: "A runner-input fixture.",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    unavailableResult: "fixture unavailable",
    requiredCapability: "sketch"
  });
}

describe("runner-facing AgentRoom tool set", () => {
  it("keeps a stable catalog separate from a narrower turn allowlist", async () => {
    registerFixture();
    const prepared = prepareAgentRunnerToolSet({
      runId: "turn-1",
      sessionKey: "session-1",
      catalog: [logicalId],
      allowed: [],
      handlers: {},
      isLive: () => true
    });

    expect(prepared.tools.catalog.map((tool) => tool.name)).toEqual(["test_runner_input"]);
    expect(prepared.tools.binding).toMatchObject({ runId: "turn-1", allowedNames: [] });
    await expect(prepared.tools.binding.invoke({
      callId: "call-1",
      name: "test_runner_input",
      arguments: {},
      signal: new AbortController().signal
    })).resolves.toContain("not available");
  });

  it("propagates call cancellation and refuses every call after disposal", async () => {
    registerFixture();
    const seenSignals: AbortSignal[] = [];
    const prepared = prepareAgentRunnerToolSet({
      runId: "turn-1",
      sessionKey: "session-1",
      catalog: [logicalId],
      allowed: [logicalId],
      handlers: {
        [logicalId]: async (_input, context) => {
          seenSignals.push(context.signal);
          await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
          return "late";
        }
      },
      isLive: () => true
    });

    const callAbort = new AbortController();
    const pending = prepared.tools.binding.invoke({
      callId: "native-call-1",
      name: "test_runner_input",
      arguments: {},
      signal: callAbort.signal
    });
    callAbort.abort();
    await expect(pending).resolves.toBe("fixture unavailable");
    expect(seenSignals[0]?.aborted).toBe(true);

    prepared.dispose();
    expect(prepared.isDisposed()).toBe(true);
    await expect(prepared.tools.binding.invoke({
      callId: "native-call-2",
      name: "test_runner_input",
      arguments: {},
      signal: new AbortController().signal
    })).resolves.toBe("fixture unavailable");
  });

  it("creates a clean binding for a later turn without reviving the first", async () => {
    registerFixture();
    const handler = async () => "ok";
    const first = prepareAgentRunnerToolSet({
      runId: "turn-1",
      sessionKey: "session-1",
      catalog: [logicalId],
      allowed: [logicalId],
      handlers: { [logicalId]: handler },
      isLive: () => true
    });
    first.dispose();
    const second = prepareAgentRunnerToolSet({
      runId: "turn-2",
      sessionKey: "session-1",
      catalog: [logicalId],
      allowed: [logicalId],
      handlers: { [logicalId]: handler },
      isLive: () => true
    });

    const invocation = {
      name: "test_runner_input",
      arguments: {},
      signal: new AbortController().signal
    };
    await expect(first.tools.binding.invoke({ ...invocation, callId: "old" }))
      .resolves.toBe("fixture unavailable");
    await expect(second.tools.binding.invoke({ ...invocation, callId: "new" }))
      .resolves.toBe("ok");
  });
});
