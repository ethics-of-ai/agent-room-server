import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-websocket-routes-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    codexRunnerProtocol: "jsonrpc",
    ...overrides
  };
};

describe("websocket event stream", () => {
  it("streams legacy turn events by default", async () => {
    const { app, eventBus } = await buildServer({ config: await config() });
    await app.ready();
    const collector = socketMessageCollector();
    const socket = await app.injectWS("/api/events", {}, collector.options);

    try {
      expect((await collector.nextEvent()).type).toBe("status_snapshot");

      eventBus.publish("agent_turn_update", {
        sessionId: "session-1",
        turnId: "turn-1",
        message: "hello"
      });

      expect(await collector.nextEvent()).toEqual(expect.objectContaining({
        type: "agent_turn_update",
        payload: expect.objectContaining({
          message: "hello"
        })
      }));
    } finally {
      socket.terminate();
      await app.close();
    }
  });

  it("can omit legacy turn update and activity events for canonical coding clients", async () => {
    const { app, eventBus } = await buildServer({ config: await config() });
    await app.ready();
    const collector = socketMessageCollector();
    const socket = await app.injectWS("/api/events?legacyTurnEvents=false", {}, collector.options);

    try {
      expect((await collector.nextEvent()).type).toBe("status_snapshot");

      eventBus.publish("coding_assistant_message_delta", {
        version: 1,
        type: "coding_assistant_message_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        runnerKind: "codex",
        delta: "canonical"
      });
      eventBus.publish("agent_turn_update", {
        sessionId: "session-1",
        turnId: "turn-1",
        message: "legacy"
      });
      eventBus.publish("agent_turn_activity", {
        sessionId: "session-1",
        turnId: "turn-1",
        activity: { kind: "legacy", title: "Legacy", content: {} }
      });
      eventBus.publish("agent_turn_succeeded", {
        sessionId: "session-1",
        turnId: "turn-1"
      });

      expect((await collector.nextEvent()).type).toBe("coding_assistant_message_delta");
      expect((await collector.nextEvent()).type).toBe("agent_turn_succeeded");
      await collector.expectNoMessage();
    } finally {
      socket.terminate();
      await app.close();
    }
  });

  it("sends initial status snapshots without retaining or rebroadcasting them", async () => {
    const { app, eventBus } = await buildServer({ config: await config() });
    await app.ready();
    const firstCollector = socketMessageCollector();
    const firstSocket = await app.injectWS("/api/events", {}, firstCollector.options);
    const secondCollector = socketMessageCollector();
    let secondSocket: { terminate(): void } | undefined;

    try {
      const firstSnapshot = await firstCollector.nextEvent();
      expect(firstSnapshot.type).toBe("status_snapshot");
      expect(statusSnapshotRecentEventTypes(firstSnapshot)).toEqual([]);
      expect(eventBus.getRecentEvents(200).map((event) => event.type)).not.toContain("status_snapshot");

      secondSocket = await app.injectWS("/api/events", {}, secondCollector.options);
      const secondSnapshot = await secondCollector.nextEvent();
      expect(secondSnapshot.type).toBe("status_snapshot");
      expect(statusSnapshotRecentEventTypes(secondSnapshot)).toEqual([]);
      await firstCollector.expectNoMessage();
    } finally {
      firstSocket.terminate();
      secondSocket?.terminate();
      await app.close();
    }
  });
});

function socketMessageCollector(): {
  options: { onInit(socket: { on(event: "message", listener: (data: unknown) => void): void }): void };
  nextEvent(): Promise<{ type: string; payload?: unknown }>;
  expectNoMessage(): Promise<void>;
} {
  const messages: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  const push = (data: unknown): void => {
    const message = socketMessageText(data);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      messages.push(message);
    }
  };

  return {
    options: {
      onInit(socket) {
        socket.on("message", push);
      }
    },
    async nextEvent() {
      const message = messages.shift() ?? await new Promise<string>((resolve) => waiters.push(resolve));
      return JSON.parse(message) as { type: string; payload?: unknown };
    },
    async expectNoMessage() {
      if (messages.length > 0) {
        throw new Error("Unexpected WebSocket message");
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => reject(new Error("Unexpected WebSocket message"));
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve();
        }, 50);
      });
    }
  };
}

function socketMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return String(data);
}

function statusSnapshotRecentEventTypes(event: { payload?: unknown }): string[] {
  const payload = event.payload as { snapshot?: { recentEvents?: Array<{ type?: string }> } } | undefined;
  return payload?.snapshot?.recentEvents?.map((recentEvent) => recentEvent.type ?? "") ?? [];
}
