import { describe, expect, it } from "vitest";
import {
  CursorHost,
  parseCursorHostFrame,
  type CursorHostTransport
} from "../src/runner/cursor/host";
import { MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN } from "../src/runner/cursor/delta";
import type { CursorRun, CursorSdk, CursorSdkAgent } from "../src/runner/cursor/sdk";

interface FakeRunOptions {
  messages?: Array<Record<string, unknown>>;
  deltas?: Array<Record<string, unknown>>;
  result?: { status: "finished" | "error" | "cancelled"; result?: string; error?: { message: string } };
  /** When set, the model "calls" the custom question tool with these args. */
  askQuestion?: Record<string, unknown>;
  /** When set, the run stays in flight until `cancel()` settles it. */
  hangUntilCancel?: boolean;
}

interface FakeSdkOptions {
  models?: unknown[];
  run?: FakeRunOptions;
}

function fakeSdk(options: FakeSdkOptions = {}): {
  sdk: CursorSdk;
  created: Array<Record<string, unknown>>;
  resumed: Array<{ agentId: string; options: Record<string, unknown> }>;
  openedStores: Array<{ workspaceRef: string; stateRoot: string }>;
  cancelled: string[];
  sent: Array<Record<string, unknown>>;
} {
  const created: Array<Record<string, unknown>> = [];
  const resumed: Array<{ agentId: string; options: Record<string, unknown> }> = [];
  const openedStores: Array<{ workspaceRef: string; stateRoot: string }> = [];
  const cancelled: string[] = [];
  const sent: Array<Record<string, unknown>> = [];

  const makeAgent = (agentOptions: Record<string, unknown>, agentId: string): CursorSdkAgent => ({
    agentId,
    close: () => undefined,
    send: async (_message, sendOptions) => {
      sent.push((sendOptions ?? {}) as Record<string, unknown>);
      let settleHang: (() => void) | undefined;
      const hung = new Promise<void>((resolve) => {
        settleHang = resolve;
      });
      const run: CursorRun = {
        id: "run-fake-1",
        async *stream() {
          const askArgs = options.run?.askQuestion;
          if (askArgs) {
            const customTools = (agentOptions.local as { customTools?: Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }> })?.customTools;
            const tool = customTools?.ask_user_question;
            const answer = tool ? await tool.execute(askArgs) : "no tool";
            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer=${answer}` }] } };
          }
          for (const message of options.run?.messages ?? []) yield message;
          for (const delta of options.run?.deltas ?? []) sendOptions?.onDelta?.({ update: delta as { type: string } });
          if (options.run?.hangUntilCancel) await hung;
        },
        wait: async () => {
          if (options.run?.hangUntilCancel) await hung;
          return options.run?.result ?? { id: "run-fake-1", status: "finished", result: "done" };
        },
        cancel: async () => {
          cancelled.push(run.id);
          settleHang?.();
        }
      };
      return run;
    }
  });

  const sdk: CursorSdk = {
    Agent: {
      create: async (agentOptions) => {
        created.push(agentOptions as Record<string, unknown>);
        return makeAgent(agentOptions as Record<string, unknown>, "agent-created-1");
      },
      resume: async (agentId, agentOptions) => {
        resumed.push({ agentId, options: (agentOptions ?? {}) as Record<string, unknown> });
        return makeAgent((agentOptions ?? {}) as Record<string, unknown>, agentId);
      }
    },
    Cursor: { models: { list: async () => options.models ?? [{ id: "composer-2.5" }] } },
    openStore: async (storeOptions) => {
      openedStores.push(storeOptions);
      return { store: storeOptions };
    },
    version: "fake-1.2.3"
  };
  return { sdk, created, resumed, openedStores, cancelled, sent };
}

function recordingTransport(): {
  transport: CursorHostTransport;
  notifications: Array<{ method: string; params: unknown }>;
  requests: Array<{ method: string; params: unknown }>;
  answer: (result: string) => void;
} {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let resolveRequest: ((value: unknown) => void) | undefined;
  return {
    notifications,
    requests,
    answer: (result: string) => resolveRequest?.({ result }),
    transport: {
      notify: (method, params) => notifications.push({ method, params }),
      request: (method, params) =>
        new Promise((resolve) => {
          requests.push({ method, params });
          resolveRequest = resolve;
        })
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("CursorHost", () => {
  it("initializes, starts a fresh agent, and pins the store under the state root", async () => {
    const sdk = fakeSdk();
    const { transport, notifications } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);

    expect(await host.handle("initialize", { stateRoot: "/state/cursor/agents" })).toEqual({ sdkVersion: "fake-1.2.3" });
    const start = await host.handle("agent/start", {
      cwd: "/workspace",
      model: { id: "composer-2.5" },
      settingSources: ["project"],
      sandbox: true,
      autoReview: false,
      disallowedTools: ["askQuestion"],
      questionTool: true
    });
    expect(start).toEqual({ agentId: "agent-created-1", resumed: false });
    expect(sdk.openedStores).toEqual([{ workspaceRef: "/workspace", stateRoot: "/state/cursor/agents" }]);
    // The question tool is registered because the channel is on.
    expect((sdk.created[0].local as { customTools?: Record<string, unknown> }).customTools).toHaveProperty("ask_user_question");
    expect((sdk.created[0].local as { sandboxOptions?: { enabled: boolean } }).sandboxOptions).toEqual({ enabled: true });
    expect(notifications).toEqual([]);
  });

  it("resumes when handed an agent id, and omits the question tool when asked", async () => {
    const sdk = fakeSdk();
    const { transport } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);
    await host.handle("initialize", { stateRoot: "/state" });
    const start = await host.handle("agent/start", {
      cwd: "/workspace",
      agentId: "agent-prior",
      model: { id: "composer-2.5" },
      settingSources: [],
      sandbox: true,
      autoReview: false,
      disallowedTools: ["askQuestion"],
      questionTool: false
    });
    expect(start).toEqual({ agentId: "agent-prior", resumed: true });
    expect(sdk.resumed[0].agentId).toBe("agent-prior");
    expect((sdk.resumed[0].options.local as { customTools?: unknown }).customTools).toBeUndefined();
    await host.handle("agent/send", { text: "recover", force: true });
    expect(sdk.sent[0].local).toEqual({ force: true });
  });

  it("decodes and caps shell-output deltas before forwarding them", async () => {
    const sdk = fakeSdk({
      run: {
        messages: [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }],
        deltas: [
          { type: "text-delta", text: "ignored" },
          { type: "shell-output-delta", callId: "c1", event: { case: "stdout", value: { data: "out" } } },
          {
            type: "shell-output-delta",
            callId: "c1",
            event: { case: "stderr", value: { data: "x".repeat(MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN) } }
          }
        ],
        result: { status: "finished", result: "final" }
      }
    });
    const { transport, notifications } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);
    await host.handle("initialize", { stateRoot: "/state" });
    await host.handle("agent/start", {
      cwd: "/w",
      model: { id: "composer-2.5" },
      settingSources: [],
      sandbox: true,
      autoReview: false,
      disallowedTools: [],
      questionTool: false
    });
    const send = await host.handle("agent/send", { text: "go" });
    expect(send).toEqual({ runId: "run-fake-1" });
    await flush();

    const methods = notifications.map((n) => n.method);
    expect(methods).toContain("run/message");
    const deltas = notifications.filter((n) => n.method === "run/delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0].params as { update: unknown }).update).toEqual({
      type: "shell-output-delta",
      callId: "c1",
      stream: "stdout",
      data: "out"
    });
    const forwardedBytes = deltas.reduce(
      (total, notification) =>
        total + Buffer.byteLength((notification.params as { update: { data: string } }).update.data, "utf8"),
      0
    );
    expect(forwardedBytes).toBe(MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN);
    expect(notifications.at(-1)).toEqual({
      method: "run/result",
      params: { runId: "run-fake-1", status: "finished", result: "final" }
    });
  });

  it("relays the question tool's callback to the backend and returns the answer to the model", async () => {
    const sdk = fakeSdk({
      run: { askQuestion: { questions: [{ question: "Which?", options: [{ label: "A" }] }] }, result: { status: "finished" } }
    });
    const { transport, requests, notifications, answer } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);
    await host.handle("initialize", { stateRoot: "/state" });
    await host.handle("agent/start", {
      cwd: "/w",
      model: { id: "composer-2.5" },
      settingSources: [],
      sandbox: true,
      autoReview: false,
      disallowedTools: ["askQuestion"],
      questionTool: true
    });
    await host.handle("agent/send", { text: "go" });
    await flush();
    expect(requests).toEqual([
      { method: "question/ask", params: { input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] } } }
    ]);
    answer("The person answered: A");
    await flush();
    const assistant = notifications.find(
      (n) => n.method === "run/message" && ((n.params as { message: { type: string } }).message.type === "assistant")
    );
    expect(JSON.stringify(assistant)).toContain("answer=The person answered: A");
  });

  it("cancels the active run and refuses an unknown method", async () => {
    const sdk = fakeSdk({ run: { hangUntilCancel: true, result: { status: "cancelled" } } });
    const { transport } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);
    await host.handle("initialize", { stateRoot: "/state" });
    await host.handle("agent/start", {
      cwd: "/w",
      model: { id: "composer-2.5" },
      settingSources: [],
      sandbox: true,
      autoReview: false,
      disallowedTools: [],
      questionTool: false
    });
    await host.handle("agent/send", { text: "go" });
    await flush();
    expect(await host.handle("run/cancel", { runId: "run-fake-1" })).toEqual({});
    expect(sdk.cancelled).toEqual(["run-fake-1"]);
    await expect(host.handle("nope/method", {})).rejects.toThrow(/Method not found/);
  });

  it("lists models for the capability probe", async () => {
    const sdk = fakeSdk({ models: [{ id: "composer-2.5" }, { id: "claude-opus-5" }] });
    const { transport } = recordingTransport();
    const host = new CursorHost(sdk.sdk, transport);
    await host.handle("initialize", { stateRoot: "/state" });
    expect(await host.handle("models/list", {})).toEqual({ models: [{ id: "composer-2.5" }, { id: "claude-opus-5" }] });
  });

  it("rejects non-object and incomplete JSON-RPC frames without dereferencing them", () => {
    for (const line of ["null", "[]", "42", '"text"', '{"id":1}']) {
      expect(parseCursorHostFrame(line)).toBeUndefined();
    }
    expect(parseCursorHostFrame('{"id":1,"method":"initialize","params":{}}')).toEqual({
      id: 1,
      method: "initialize",
      params: {}
    });
  });
});
