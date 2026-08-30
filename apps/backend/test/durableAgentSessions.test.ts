import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import {
  config,
  nativeSessionRunner,
  nativeSessionSequenceRunner,
  registerWorkspaceOffline,
  sessionDocument,
  waitForSession,
  writeSessionDocument
} from "./support/agentSessionHarness";

describe("durable agent sessions", () => {
  it("gates session list and detail reads when their summaries can carry message text", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-authenticated-summary";
    const persisted = sessionDocument(sessionId, workspace, {
      runnerKind: "claude_code",
      nativeSessionId: "native-thread-authenticated-summary"
    });
    (persisted.session as Record<string, unknown>).lastMessage = "private assistant text";
    await writeSessionDocument(serviceConfig, persisted);
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-authenticated-summary") }
    });

    const listWithoutToken = await app.inject({ method: "GET", url: "/api/agent-sessions" });
    const detailWithoutToken = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(listWithoutToken.statusCode).toBe(401);
    expect(detailWithoutToken.statusCode).toBe(401);

    const headers = { authorization: "Bearer secret-token" };
    const list = await app.inject({ method: "GET", url: "/api/agent-sessions", headers });
    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions[0].lastMessage).toBe("private assistant text");
    expect(detail.statusCode).toBe(200);
    expect(detail.json().session.lastMessage).toBe("private assistant text");

    await app.close();
  });

  it("restores a thread across a backend restart and seeds its runner with the native id", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const first = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-1") }
    });
    const registered = await first.app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const created = await first.app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "claude_code", title: "Survives restarts" }
    });
    const sessionId = created.json().session.id;
    await first.app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "remember this" }
    });
    await waitForSession(first.app, sessionId, "idle");
    await first.app.close();

    const seeds: Array<{ sessionId: string; nativeSessionId: string; interrupted: boolean }> = [];
    const runner = nativeSessionRunner("native-thread-1", { seeds });
    const second = await buildServer({ config: serviceConfig, runners: { claude_code: runner } });

    const list = await second.app.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(list.json().sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        title: "Survives restarts",
        runnerKind: "claude_code",
        status: "idle",
        turnCount: 1,
        runner: expect.objectContaining({ nativeSessionId: "native-thread-1" })
      })
    ]);
    const messages = await second.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json().messages).toEqual([
      expect.objectContaining({ role: "user", content: "remember this", status: "sent" }),
      expect.objectContaining({ role: "assistant", content: "noted", status: "succeeded" })
    ]);
    expect(seeds).toEqual([{ sessionId, nativeSessionId: "native-thread-1", interrupted: false }]);
    // Process-scoped counters describe this process; the restored thread is
    // still counted as a session.
    const status = await second.app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().metrics).toMatchObject({ totalSessions: 1, completedTurns: 0 });

    // The restored thread takes a turn like a live one.
    const turn = await second.app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "and this" }
    });
    expect(turn.statusCode).toBe(202);
    await waitForSession(second.app, sessionId, "idle");
    const after = await second.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(after.json().messages).toHaveLength(4);
    await second.app.close();
  });

  it("settles a turn that was running at shutdown as failed, audits it, and seeds the runner as interrupted", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-interrupted";
    await writeSessionDocument(serviceConfig, sessionDocument(sessionId, workspace, {
      runnerKind: "claude_code",
      nativeSessionId: "native-thread-interrupted",
      running: true
    }));

    const seeds: Array<{ sessionId: string; nativeSessionId: string; interrupted: boolean }> = [];
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-interrupted", { seeds }) }
    });

    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(detail.json().session).toMatchObject({
      status: "failed",
      error: "Backend restarted during this turn",
      lastMessage: "Backend restarted during this turn"
    });
    expect(detail.json().session.activeTurnId).toBeUndefined();
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json().messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello", status: "sent" }),
      expect.objectContaining({
        role: "assistant",
        turnId: `turn-${sessionId}`,
        content: "Backend restarted during this turn",
        status: "failed"
      })
    ]);
    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    const failures = audit.json().events.filter((event: { type: string }) => event.type === "agent_turn_failed");
    expect(failures).toEqual([
      expect.objectContaining({ type: "agent_turn_failed", sessionId, error: "Backend restarted during this turn" })
    ]);
    expect(seeds).toEqual([{ sessionId, nativeSessionId: "native-thread-interrupted", interrupted: true }]);
    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().metrics).toMatchObject({
      totalSessions: 1,
      completedTurns: 0,
      failedTurns: 0,
      cancelledTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    });

    // The settled state is what the next process reads, not the running one.
    await app.close();
    const reopened = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-interrupted") }
    });
    const again = await reopened.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(again.json().session.status).toBe("failed");
    const auditAgain = await reopened.app.inject({ method: "GET", url: "/api/audit" });
    expect(auditAgain.json().events.filter((event: { type: string }) => event.type === "agent_turn_failed")).toHaveLength(1);
    await reopened.app.close();
  });

  it("hydrates a thread whose runner this process does not register and refuses its next turn", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-orphaned-runner";
    await writeSessionDocument(serviceConfig, sessionDocument(sessionId, workspace, {
      runnerKind: "acp_removed_adapter",
      nativeSessionId: "acp-session-old"
    }));
    const { app } = await buildServer({ config: serviceConfig });

    const list = await app.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(list.json().sessions).toEqual([expect.objectContaining({ id: sessionId, runnerKind: "acp_removed_adapter" })]);
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json().messages).toHaveLength(2);

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "continue" }
    });
    expect(turn.statusCode).toBe(400);
    expect(turn.json().error).toContain("acp_removed_adapter");
    await app.close();
  });

  it("refuses a turn on a hydrated thread whose runner declares no restore path, and allows one that never had a conversation", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    await writeSessionDocument(serviceConfig, sessionDocument("agent-session-unrestorable", workspace, {
      runnerKind: "deepseek",
      nativeSessionId: "deepseek-session-old"
    }));
    await writeSessionDocument(serviceConfig, sessionDocument("agent-session-never-started", workspace, {
      runnerKind: "deepseek"
    }));
    const seeds: Array<{ sessionId: string; nativeSessionId: string; interrupted: boolean }> = [];
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { deepseek: nativeSessionRunner("deepseek-session-new", { seeds }) }
    });

    const refused = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-unrestorable/turns",
      payload: { message: "continue" }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(
      "DeepSeek Harness cannot continue this session because its runtime stopped and no restore path is verified; create a new AgentRoom session"
    );
    // The host would not honor the seed either, so the service never offers it.
    expect(seeds).toEqual([]);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-never-started/turns",
      payload: { message: "begin" }
    });
    expect(allowed.statusCode).toBe(202);
    await waitForSession(app, "agent-session-never-started", "idle");
    await app.close();
  });

  it("removes the document when a session is deleted, so it is never hydrated again", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const first = await buildServer({ config: serviceConfig });
    const registered = await first.app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const created = await first.app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = created.json().session.id;
    await first.durableSessions.flush();
    const documentPath = join(serviceConfig.stateDir, "sessions", `${sessionId}.json`);
    expect(JSON.parse(await readFile(documentPath, "utf8")).session.id).toBe(sessionId);

    const removed = await first.app.inject({ method: "DELETE", url: `/api/agent-sessions/${sessionId}` });
    expect(removed.statusCode).toBe(204);
    await expect(readFile(documentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await first.app.close();

    const second = await buildServer({ config: serviceConfig });
    const list = await second.app.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(list.json().sessions).toEqual([]);
    await second.app.close();
  });
});

describe("durable agent sessions: resume that did not take", () => {
  it("keeps the hydrated seed until a session start reports a native id", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-delayed-native-id";
    await writeSessionDocument(serviceConfig, sessionDocument(sessionId, workspace, {
      runnerKind: "claude_code",
      nativeSessionId: "native-thread-old"
    }));
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionSequenceRunner([undefined, "native-thread-new"]) }
    });

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "continue" } });
    await waitForSession(app, sessionId, "idle");
    const messages = (await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${sessionId}/messages`
    })).json().messages;
    expect(messages.filter((message: { role: string }) => message.role === "system")).toEqual([
      expect.objectContaining({
        content: "This thread could not be resumed after a backend restart. The agent has started a new conversation and has not seen the messages above."
      })
    ]);

    await app.close();
  });

  it("appends one system message when the runner reports a different native id than the seed", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-not-resumed";
    await writeSessionDocument(serviceConfig, sessionDocument(sessionId, workspace, {
      runnerKind: "claude_code",
      nativeSessionId: "native-thread-old"
    }));
    // The runner starts a fresh conversation under a new id: a rejected
    // Codex resume, a pruned transcript, a CLI upgrade.
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-new") }
    });

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "second" } });
    await waitForSession(app, sessionId, "idle");
    const messages = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).json().messages;
    expect(messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
      ["user", "second"],
      ["system", "This thread could not be resumed after a backend restart. The agent has started a new conversation and has not seen the messages above."],
      ["assistant", "noted"]
    ]);
    const session = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` })).json().session;
    expect(session.runner.nativeSessionId).toBe("native-thread-new");

    // Once per hydrated session: a later start reports nothing new.
    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "third" } });
    await waitForSession(app, sessionId, "idle");
    const after = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).json().messages;
    expect(after.filter((message: { role: string }) => message.role === "system")).toHaveLength(1);
    await app.close();
  });

  it("appends nothing when the runner reports the seeded id", async () => {
    const serviceConfig = await config();
    const workspace = await registerWorkspaceOffline(serviceConfig);
    const sessionId = "agent-session-resumed";
    await writeSessionDocument(serviceConfig, sessionDocument(sessionId, workspace, {
      runnerKind: "claude_code",
      nativeSessionId: "native-thread-kept"
    }));
    const { app } = await buildServer({
      config: serviceConfig,
      runners: { claude_code: nativeSessionRunner("native-thread-kept") }
    });

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "second" } });
    await waitForSession(app, sessionId, "idle");
    const messages = (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).json().messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    await app.close();
  });
});
