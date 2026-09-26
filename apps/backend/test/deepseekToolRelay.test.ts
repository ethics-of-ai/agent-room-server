import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekToolRelay } from "../src/runner/deepseek/cordis/DeepSeekToolRelay";
import { AGENTROOM_TOOLS_MAX_FRAME_BYTES } from "../src/runner/deepseek/cordis/protocol";

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

function lines(stream: Duplex): { next(): Promise<any> } {
  let buffer = "";
  const waits: Array<(value: any) => void> = [];
  const queued: any[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const value = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const waiter = waits.shift();
      if (waiter) waiter(value); else queued.push(value);
    }
  });
  return {
    next: () => new Promise((resolve) => {
      const value = queued.shift();
      if (value !== undefined) resolve(value); else waits.push(resolve);
    })
  };
}

const catalog = [{
  name: "test_echo",
  description: "Echo a value",
  inputSchema: { type: "object" },
  outputSchema: { type: "string" }
}];

async function readyRelay() {
  const [parent, child] = duplexPair();
  const received = lines(child);
  const relay = new DeepSeekToolRelay(parent, catalog);
  child.write('{"version":1,"type":"hel');
  child.write('lo"}\n');
  expect(await received.next()).toEqual({ version: 1, type: "catalog", catalog });
  child.write(`${JSON.stringify({ version: 1, type: "ready", names: ["test_echo"] })}\n`);
  await relay.waitUntilReady(100);
  return { relay, child, received };
}

describe("DeepSeek AgentRoom tool relay", () => {
  it("binds one run, forwards invocation and cancellation, then unbinds cleanly", async () => {
    const { relay, child, received } = await readyRelay();
    let release!: (value: string) => void;
    const invoke = vi.fn((_input) => new Promise<string>((resolve) => { release = resolve; }));
    relay.bind({ runId: "run-1", allowedNames: ["test_echo"], invoke });
    expect(await received.next()).toEqual({ version: 1, type: "bind", runId: "run-1", allowedNames: ["test_echo"] });

    child.write(`${JSON.stringify({
      version: 1, type: "invoke", runId: "run-1", callId: "call-1", name: "test_echo", arguments: { text: "hi" }
    })}\n`);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    child.write(`${JSON.stringify({ version: 1, type: "cancel", runId: "run-1", callId: "call-1" })}\n`);
    await vi.waitFor(() => expect(invoke.mock.calls[0]![0].signal.aborted).toBe(true));
    release("cancelled");
    expect(await received.next()).toEqual({
      version: 1, type: "result", runId: "run-1", callId: "call-1", result: "cancelled"
    });
    relay.unbind("run-1");
    expect(await received.next()).toEqual({ version: 1, type: "unbind", runId: "run-1" });
    relay.bind({ runId: "run-2", allowedNames: [], invoke: vi.fn() });
    expect(await received.next()).toEqual({ version: 1, type: "bind", runId: "run-2", allowedNames: [] });
    relay.close();
  });

  it("refuses unbound names and stale run ids without invoking authority", async () => {
    const { relay, child, received } = await readyRelay();
    const invoke = vi.fn();
    relay.bind({ runId: "run-live", allowedNames: [], invoke });
    await received.next();
    child.write(`${JSON.stringify({
      version: 1, type: "invoke", runId: "run-stale", callId: "call-1", name: "test_echo", arguments: {}
    })}\n`);
    const response = await received.next();
    expect(response).toMatchObject({ version: 1, type: "result", runId: "run-stale", callId: "call-1" });
    expect(response.result).toContain("not available");
    expect(invoke).not.toHaveBeenCalled();
    relay.close();
  });

  it("refuses a completed call id replay without running the binding twice", async () => {
    const { relay, child, received } = await readyRelay();
    const invoke = vi.fn(async () => "first result");
    relay.bind({ runId: "run-live", allowedNames: ["test_echo"], invoke });
    await received.next();
    const frame = `${JSON.stringify({
      version: 1, type: "invoke", runId: "run-live", callId: "call-replayed", name: "test_echo", arguments: {}
    })}\n`;
    child.write(frame);
    expect(await received.next()).toMatchObject({ result: "first result" });
    child.write(frame);
    const replay = await received.next();
    expect(replay.result).toContain("not available");
    expect(invoke).toHaveBeenCalledOnce();
    relay.close();
  });

  it("closes on malformed, oversized, and catalog-replay frames", async () => {
    for (const frame of [
      "not-json\n",
      `${"x".repeat(AGENTROOM_TOOLS_MAX_FRAME_BYTES + 1)}\n`,
      `${JSON.stringify({ version: 1, type: "hello" })}\n${JSON.stringify({ version: 1, type: "hello" })}\n`
    ]) {
      const [parent, child] = duplexPair();
      const relay = new DeepSeekToolRelay(parent, catalog);
      child.write(frame);
      await expect(relay.waitUntilReady(50)).rejects.toThrow();
    }
  });
});
