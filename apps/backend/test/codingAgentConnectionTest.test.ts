import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server";
import type { AgentRunner } from "../src/runner/AgentRunner";
import { config } from "./support/agentSessionHarness";

describe("explicit provider connection test", () => {
  it("requires auth, accepts no arbitrary prompt, serializes tests and never runs during discovery", async () => {
    let finish!: (value: { ok: boolean; message: string }) => void;
    const testConnection = vi.fn(() => new Promise<{ ok: boolean; message: string }>((resolve) => { finish = resolve; }));
    const runner = {
      kind: "deepseek", testConnection, async *run() {}, async cancel() {}, async dispose() {},
      async getCapabilities() { return { runnerKind: "deepseek", error: "fixture unavailable" }; }
    } as unknown as AgentRunner;
    const { app } = await buildServer({ config: await config({ runnerKind: "deepseek", requireAuth: true, authToken: "test-token" }), runners: { deepseek: runner } });
    const headers = { authorization: "Bearer test-token" };
    try {
      expect((await app.inject({ method: "POST", url: "/api/coding-agent/connection-test", payload: {} })).statusCode).toBe(401);
      await app.inject({ method: "GET", url: "/api/coding-agent/capabilities", headers });
      expect(testConnection).not.toHaveBeenCalled();
      expect((await app.inject({ method: "POST", url: "/api/coding-agent/connection-test", headers, payload: { prompt: "execute" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/coding-agent/connection-test", headers, payload: { runnerKind: "codex" } })).statusCode).toBe(400);
      const pending = app.inject({ method: "POST", url: "/api/coding-agent/connection-test", headers, payload: {} });
      void pending.then(() => undefined);
      await vi.waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
      expect((await app.inject({ method: "POST", url: "/api/coding-agent/connection-test", headers, payload: {} })).statusCode).toBe(409);
      finish({ ok: false, message: "Provider unavailable" });
      expect((await pending).json()).toEqual({ ok: false, message: "Provider unavailable" });
    } finally { await app.close(); }
  });
});
