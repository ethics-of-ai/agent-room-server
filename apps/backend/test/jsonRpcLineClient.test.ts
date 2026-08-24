import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcLineClient, JsonRpcMethodNotFoundError } from "../src/runner/shared/JsonRpcLineClient";

/** A stand-in child: stdout we can feed frames into, stdin that records what was written. */
function fakeChild(): { child: ChildProcessWithoutNullStreams; stdout: EventEmitter; written: () => unknown[] } {
  const stdout = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (data: string, cb?: (error?: Error | null) => void) => boolean };
  const frames: unknown[] = [];
  stdin.write = (data, cb) => {
    for (const line of data.split("\n")) if (line.trim()) frames.push(JSON.parse(line));
    cb?.(null);
    return true;
  };
  const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; stdout: EventEmitter };
  child.stdin = stdin;
  child.stdout = stdout;
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdout, written: () => frames };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JsonRpcLineClient server requests", () => {
  it("serves a child's request through the handler and writes the result back", async () => {
    const { child, stdout, written } = fakeChild();
    const client = new JsonRpcLineClient(child, "fake");
    client.onRequest(async (request) => {
      if (request.method === "ask") return { echoed: request.params };
      throw new JsonRpcMethodNotFoundError(request.method);
    });
    stdout.emit("data", Buffer.from(`${JSON.stringify({ id: 7, method: "ask", params: { q: 1 } })}\n`));
    await tick();
    expect(written()).toEqual([{ id: 7, result: { echoed: { q: 1 } } }]);

    stdout.emit("data", Buffer.from(`${JSON.stringify({ id: 8, method: "approve", params: {} })}\n`));
    await tick();
    expect(written().at(-1)).toEqual({ id: 8, error: { code: -32601, message: "Method not found: approve" } });
    client.dispose();
  });

  it("refuses every request with method-not-found when no handler is registered", async () => {
    const { child, stdout, written } = fakeChild();
    const client = new JsonRpcLineClient(child, "fake");
    stdout.emit("data", Buffer.from(`${JSON.stringify({ id: 1, method: "anything", params: {} })}\n`));
    await tick();
    expect(written()).toEqual([{ id: 1, error: { code: -32601, message: "Method not found: anything" } }]);
    client.dispose();
  });

  it("still routes notifications and responses as before", async () => {
    const { child, stdout, written } = fakeChild();
    const client = new JsonRpcLineClient(child, "fake");
    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.method));
    const pending = client.request("ping", {});
    const id = (written()[0] as { id: number }).id;
    stdout.emit("data", Buffer.from(`${JSON.stringify({ method: "note", params: {} })}\n${JSON.stringify({ id, result: "pong" })}\n`));
    await expect(pending).resolves.toBe("pong");
    expect(notifications).toEqual(["note"]);
    client.dispose();
  });
});
