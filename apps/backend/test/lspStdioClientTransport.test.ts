import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspStdioClient } from "./support/LspStdioClient";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeServer(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "agentroom-fake-lsp-"));
  temporaryRoots.push(root);
  const path = join(root, "server.cjs");
  writeFileSync(path, String.raw`
let buffer = Buffer.alloc(0);
const send = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + payload.length + '\r\n\r\n'), payload]));
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'));
    if (!match) { buffer = buffer.subarray(end + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      send({ jsonrpc: '2.0', id: 'server-1', method: 'workspace/configuration', params: { items: [{}] } });
      process.stderr.write('x'.repeat(512));
    } else if (message.id === 'server-1') {
      send({ jsonrpc: '2.0', method: 'fixture/acknowledged', params: message.result });
    } else if (message.method === 'echo') {
      send({ jsonrpc: '2.0', id: message.id, result: message.params });
    } else if (message.method === '$/cancelRequest') {
      send({ jsonrpc: '2.0', id: message.params.id, error: { code: -32800, message: 'cancelled' } });
    } else if (message.method === 'crash') {
      process.exit(17);
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`);
  return { root, path };
}

describe("LspStdioClient Phase 0 transport evidence", () => {
  it("frames traffic, bounds stderr, answers admitted server requests, and cancels", async () => {
    const server = fakeServer();
    const client = new LspStdioClient(process.execPath, [server.path], server.root, {
      maxStderrBytes: 128,
      serverRequestHandler: (method) => {
        if (method === "workspace/configuration") return [null];
        throw new Error("not admitted");
      }
    });
    const acknowledged = new Promise<unknown>((resolve) => {
      client.onNotification((method, params) => {
        if (method === "fixture/acknowledged") resolve(params);
      });
    });

    try {
      await client.request("initialize", {}, 2_000);
      expect(await acknowledged).toEqual([null]);
      expect(await client.request("echo", { value: "round trip" }, 2_000)).toEqual({
        value: "round trip"
      });
      const pending = client.requestWithHandle("slow", {}, 2_000);
      client.cancelRequest(pending.id);
      await expect(pending.promise).rejects.toThrow("cancelled");

      expect(client.observedServerRequestMethods).toEqual(["workspace/configuration"]);
      expect(client.observedNotificationMethods).toEqual(["fixture/acknowledged"]);
      expect(client.stderrTruncated).toBe(true);
      expect(Buffer.byteLength(client.stderrTail)).toBe(128);
      expect(client.wireStats.inboundFrames).toBeGreaterThanOrEqual(4);
      expect(client.wireStats.outboundFrames).toBeGreaterThanOrEqual(5);

      await client.request("shutdown", null, 2_000);
      client.notify("exit", null);
      await expect(client.waitForExit(2_000)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      client.dispose();
    }
  });

  it("rejects pending requests when the child crashes", async () => {
    const server = fakeServer();
    const client = new LspStdioClient(process.execPath, [server.path], server.root);
    try {
      await client.request("initialize", {}, 2_000);
      await expect(client.request("crash", {}, 2_000)).rejects.toThrow("language server exited");
      await expect(client.waitForExit(2_000)).resolves.toEqual({ code: 17, signal: null });
    } finally {
      client.dispose();
    }
  });
});
