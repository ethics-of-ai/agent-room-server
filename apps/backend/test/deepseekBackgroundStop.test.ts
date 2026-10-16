import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { serveAgentRoomRelay } from "../src/runner/deepseek/cordis/agentRoomToolsPlugin";
import { DeepSeekToolRelay } from "../src/runner/deepseek/cordis/DeepSeekToolRelay";

function duplexPair(): [Duplex, Duplex] {
  let first!: Duplex;
  let second!: Duplex;
  first = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { second.push(Buffer.from(chunk)); callback(); },
    final(callback) { second.push(null); callback(); }
  });
  second = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { first.push(Buffer.from(chunk)); callback(); },
    final(callback) { first.push(null); callback(); }
  });
  return [first, second];
}

/** The parent relay and the plugin it talks to inside the runtime, joined by an in-memory pipe. */
async function pluginWith(services: Record<string, unknown>) {
  const [parent, child] = duplexPair();
  const guards: Array<(execution: { name: string }) => string | undefined> = [];
  const ctx = {
    tools: {
      register: vi.fn(() => () => undefined),
      guard: vi.fn((guard: (execution: { name: string }) => string | undefined) => {
        guards.push(guard);
        return () => undefined;
      })
    },
    effect: vi.fn(),
    get: (name: string) => services[name]
  };
  serveAgentRoomRelay(ctx, child);
  const relay = new DeepSeekToolRelay(parent, []);
  await relay.waitUntilReady(500);
  return Object.assign(relay, { denial: (name: string) => guards.map((guard) => guard({ name })).find(Boolean) });
}

/** Let a relay message cross the in-memory pipe. */
const delivered = () => new Promise((resolve) => setImmediate(resolve));

describe("stopping DeepSeek background work through the AgentRoom plugin", () => {
  it("kills a job as its owning session and reports a job that already ended as unknown", async () => {
    const kill = vi.fn((jobId: string) => jobId === "bash-live" ? "requested" : "already-finished");
    const relay = await pluginWith({ jobs: { kill } });

    expect(await relay.stop({ kind: "job", jobId: "bash-live", owner: "session-1" })).toBe("stopped");
    expect(kill).toHaveBeenCalledWith("bash-live", "session-1", "stopped from AgentRoom");
    expect(await relay.stop({ kind: "job", jobId: "bash-done", owner: "session-1" })).toBe("unknown_task");
    relay.close();
  });

  it("interrupts a subagent for its parent and reports a child the runtime does not know as unknown", async () => {
    const interrupt = vi.fn((childSessionId: string) => {
      if (childSessionId !== "child-1") throw new Error("unknown subagent");
    });
    const relay = await pluginWith({ subagents: { interrupt } });

    expect(await relay.stop({ kind: "subagent", childSessionId: "child-1", parentSessionId: "session-1" })).toBe("stopped");
    expect(interrupt).toHaveBeenCalledWith("child-1", { kind: "user", parentSessionId: "session-1" });
    expect(await relay.stop({ kind: "subagent", childSessionId: "child-2", parentSessionId: "session-1" })).toBe("unknown_task");
    relay.close();
  });

  it("reports a stop as unknown when the runtime mounts no job registry", async () => {
    const relay = await pluginWith({});

    expect(await relay.stop({ kind: "job", jobId: "bash-live", owner: "session-1" })).toBe("unknown_task");
    relay.close();
  });

  it("refuses new subagents while the backend pauses them, and nothing else", async () => {
    const relay = await pluginWith({});
    expect(relay.denial("subagent")).toBeUndefined();

    relay.pauseSubagents(true);
    await delivered();
    expect(relay.denial("subagent")).toMatch(/person/);
    expect(relay.denial("bash")).toBeUndefined();

    relay.pauseSubagents(false);
    await delivered();
    expect(relay.denial("subagent")).toBeUndefined();
    relay.close();
  });
});
