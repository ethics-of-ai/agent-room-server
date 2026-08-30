import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSessionService } from "../src/agent/AgentSessionService";
import { AgentTurnContextAssembler } from "../src/agent/AgentTurnContextAssembler";
import { EventBus } from "../src/events/EventBus";
import { buildServer } from "../src/server";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";
import {
  changingCompactionThresholdRunner,
  compactionThresholdRunner,
  config,
  createGitWorkspace,
  fileWritingRunner,
  lateFailureAfterCancelRunner,
  lateTokenUsageAfterCancelRunner,
  multipartFilePayload,
  newAgentSessionService,
  waitForServiceSession,
  waitForSession,
  waitForSessionWhere,
  writeCompletingJsonRpcServer,
  writeThenHangRunner
} from "./support/agentSessionHarness";

describe("agent sessions", () => {
  it("runs a turn through the configured Codex runner and records streamed output", async () => {
    // Disable standing prompt channels so this runner-echo test isolates the
    // user message; artifact and diagram delivery have dedicated coverage.
    const serviceConfig = await config({ artifactsEnabled: false, sceneEngineEnabled: false });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    await mkdir(join(selectedDirectory, ".git"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "hello from visionOS" }
    });

    expect(turn.statusCode).toBe(202);
    expect(turn.json()).toEqual({
      turn: expect.objectContaining({
        id: expect.stringMatching(/^agent-turn-/),
        sessionId: session.json().session.id,
        status: "running"
      })
    });

    const completed = await waitForSession(app, session.json().session.id, "idle");
    expect(completed.turnCount).toBe(1);
    expect(completed.lastMessage).toContain("codex heard: hello from visionOS");

    const messages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.json().session.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^agent-message-/),
        sessionId: session.json().session.id,
        turnId: turn.json().turn.id,
        role: "user",
        content: "hello from visionOS",
        status: "sent"
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^agent-message-/),
        sessionId: session.json().session.id,
        turnId: turn.json().turn.id,
        role: "assistant",
        content: expect.stringContaining("codex heard: hello from visionOS"),
        status: "succeeded"
      })
    ]);

    await app.close();
  });

  it("records selected turn context on the user message", async () => {
    const fakeServer = await writeCompletingJsonRpcServer();
    const serviceConfig = await config({
      codexRunnerProtocol: "jsonrpc",
      codexArgs: [fakeServer]
    });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    await writeFile(join(selectedDirectory, "README.md"), "# AgentRoom\n");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);
    const upload = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/attachments`,
      ...multipartFilePayload({
        fieldName: "file",
        filename: "clipboard.png",
        contentType: "image/png",
        data: imageBytes
      })
    });

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: {
        message: "Use the selected context.",
        context: {
          paths: ["README.md"],
          attachments: [upload.json().attachment.id]
        }
      }
    });

    expect(turn.statusCode).toBe(202);
    await waitForSession(app, session.json().session.id, "idle");

    const messages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.json().session.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages[0]).toEqual(expect.objectContaining({
      role: "user",
      content: "Use the selected context.",
      context: {
        paths: ["README.md"],
        attachments: [
          {
            id: upload.json().attachment.id,
            kind: "image",
            sourceName: "clipboard.png",
            contentType: "image/png",
            sizeBytes: imageBytes.length
          }
        ]
      }
    }));

    await app.close();
  });

  it("rejects image attachment turns when the runner protocol cannot accept input parts", async () => {
    const serviceConfig = await config({ codexRunnerProtocol: "exec" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    await mkdir(join(selectedDirectory, "docs", "diagrams"), { recursive: true });
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);
    const upload = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/attachments`,
      ...multipartFilePayload({
        fieldName: "file",
        filename: "clipboard.png",
        contentType: "image/png",
        data: imageBytes
      })
    });
    const humanEdit = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${registered.json().workspace.id}/file`,
      payload: {
        path: "docs/diagrams/checkout.diagram.human.json",
        content: JSON.stringify({ schemaVersion: 1, overrides: [{ id: "orders", locked: true }] })
      }
    });
    expect(humanEdit.statusCode).toBe(201);

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: {
        message: "Use this image.",
        context: {
          attachments: [upload.json().attachment.id]
        }
      }
    });
    const messages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.json().session.id}/messages`
    });

    expect(turn.statusCode).toBe(400);
    expect(turn.json()).toEqual({ error: "Image attachments require CODEX_RUNNER_PROTOCOL=jsonrpc" });
    expect(messages.json().messages).toEqual([]);

    const retry = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "Retry without the image." }
    });
    expect(retry.statusCode).toBe(202);
    await waitForSession(app, session.json().session.id, "idle");
    const retriedMessages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${session.json().session.id}/messages`
    });
    expect(retriedMessages.json().messages.at(-1).content).toContain("Human diagram edits");
    expect(retriedMessages.json().messages.at(-1).content).toContain("locked: orders");

    await app.close();
  });

  it("emits a live update when the runner only returns a final success message", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", ""]
    });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    await mkdir(join(selectedDirectory, ".git"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "hello from visionOS" }
    });

    await waitForSession(app, session.json().session.id, "idle");
    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    expect(logs.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent_turn_update",
        payload: expect.objectContaining({
          sessionId: session.json().session.id,
          message: "Codex process exited successfully"
        })
      })
    ]));

    await app.close();
  });

  it("rejects a second turn while a session already has a running turn", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", "setInterval(() => {}, 1000)"]
    });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "start long run" }
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "overlap" }
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "Agent session already has a running turn" });

    await app.inject({ method: "POST", url: `/api/agent-sessions/${session.json().session.id}/cancel` });
    await waitForSession(app, session.json().session.id, "idle");
    await app.close();
  });

  it("stops an active turn and leaves the session idle for steering", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", "setInterval(() => {}, 1000)"]
    });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "start long run" }
    });
    const stopped = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/cancel` });

    expect(turn.statusCode).toBe(202);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().session).toEqual(expect.objectContaining({
      id: sessionId,
      status: "idle"
    }));
    expect(stopped.json().session.activeTurnId).toBeUndefined();

    const idle = await waitForSession(app, sessionId, "idle");
    expect(idle.activeTurnId).toBeUndefined();

    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turnId: turn.json().turn.id,
        role: "assistant",
        content: "Turn stopped.",
        status: "cancelled"
      })
    ]));

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().metrics.cancelledTurns).toBe(1);

    await app.close();
  });

  it("ignores late token usage updates from a stopped turn", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const runner = lateTokenUsageAfterCancelRunner();
    const service = new AgentSessionService({
      registry,
      runners: { codex: runner },
      eventBus,
      contextAssembler: new AgentTurnContextAssembler({
        workspaceExplorer: new WorkspaceExplorer(registry),
        attachments: {
          async inputPartsForTurn() {
            return [];
          },
          async contextAttachmentsForTurn() {
            return [];
          }
        }
      })
    });
    const session = await service.createSession({ workspaceId: registered.workspace.id });
    const turn = await service.startTurn({ sessionId: session.id, message: "start long run" });

    await service.cancelTurn(session.id);
    await runner.completed;

    const stopped = await waitForServiceSession(service, session.id, "idle");
    expect(stopped.activeTurnId).toBeUndefined();
    expect(stopped.modelContextWindowTokens).toBeUndefined();
    expect(stopped.contextWindowUsedTokens).toBeUndefined();
    expect(service.getStatusSnapshot(eventBus.getRecentEvents()).metrics).toMatchObject({
      cancelledTurns: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    });
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toEqual(expect.arrayContaining([
      "agent_turn_token_usage_updated",
      "coding_token_usage_updated"
    ]));
    expect(service.listSessionMessages(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turnId: turn.id,
        role: "assistant",
        content: "Turn stopped.",
        status: "cancelled"
      })
    ]));
  });

  it("carries a runner's compaction threshold onto the session and both usage events", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const service = newAgentSessionService(registry, { codex: compactionThresholdRunner() }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id });
    await service.startTurn({ sessionId: session.id, message: "read the threshold" });

    const settled = await waitForServiceSession(service, session.id, "idle");
    expect(settled.contextCompactionThresholdTokens).toBe(160_000);

    // Both events are built from the turn record, so they also prove the turn
    // carried the value. Nothing here knows which runner reported it.
    const usageEvents = eventBus.getRecentEvents().filter((event) =>
      event.type === "agent_turn_token_usage_updated" || event.type === "coding_token_usage_updated"
    );
    expect(usageEvents).toHaveLength(2);
    for (const event of usageEvents) {
      expect(event.payload).toMatchObject({ contextCompactionThresholdTokens: 160_000 });
    }
  });

  it("leaves the compaction threshold absent for a runner that reports none", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const service = newAgentSessionService(registry, { codex: compactionThresholdRunner({ reportThreshold: false }) }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id });
    await service.startTurn({ sessionId: session.id, message: "report occupancy only" });

    const settled = await waitForServiceSession(service, session.id, "idle");
    expect(settled.contextWindowUsedTokens).toBe(12_000);
    // Absent, not zero and not a share of the window.
    expect(settled.contextCompactionThresholdTokens).toBeUndefined();
    expect(JSON.stringify(eventBus.getRecentEvents())).not.toContain("contextCompactionThresholdTokens");
  });

  it("clears a stale compaction threshold when the runner explicitly removes it", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const service = newAgentSessionService(registry, { codex: changingCompactionThresholdRunner() }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id });

    await service.startTurn({ sessionId: session.id, message: "read the threshold" });
    expect((await waitForServiceSession(service, session.id, "idle")).contextCompactionThresholdTokens).toBe(160_000);

    const secondTurn = await service.startTurn({ sessionId: session.id, message: "disable compaction" });
    const settled = await waitForServiceSession(service, session.id, "idle");
    expect(settled.contextCompactionThresholdTokens).toBeUndefined();

    const clearEvents = eventBus.getRecentEvents().filter((event) =>
      event.payload.turnId === secondTurn.id
        && (event.type === "agent_turn_token_usage_updated" || event.type === "coding_token_usage_updated")
    );
    expect(clearEvents).toHaveLength(2);
    for (const event of clearEvents) {
      expect(event.payload).toHaveProperty("contextCompactionThresholdTokens", null);
    }
  });

  it("ignores late runner failures after a session is deleted mid-turn", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const runner = lateFailureAfterCancelRunner();
    const service = new AgentSessionService({
      registry,
      runners: { codex: runner },
      eventBus,
      contextAssembler: new AgentTurnContextAssembler({
        workspaceExplorer: new WorkspaceExplorer(registry),
        attachments: {
          async inputPartsForTurn() {
            return [];
          },
          async contextAttachmentsForTurn() {
            return [];
          }
        }
      })
    });
    const session = await service.createSession({ workspaceId: registered.workspace.id });
    await service.startTurn({ sessionId: session.id, message: "start long run" });

    await service.deleteSession(session.id);
    await runner.completed;

    expect(service.getSession(session.id)).toBeUndefined();
    expect(service.getStatusSnapshot(eventBus.getRecentEvents()).metrics.failedTurns).toBe(0);
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toEqual(expect.arrayContaining([
      "agent_turn_failed",
      "coding_turn_failed"
    ]));
    expect(service.listSessionMessages(session.id)).toBeUndefined();
  });

  it("keeps a steering turn active when a stopped turn finishes cancellation cleanup", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", `
        let prompt = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { prompt += chunk; });
        process.stdin.on("end", () => {
          if (prompt.includes("first")) {
            process.stdout.write("first started\\n");
            process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150));
            setInterval(() => {}, 1000);
            return;
          }
          process.stdout.write("second started\\n");
          process.on("SIGTERM", () => process.exit(0));
          setInterval(() => {}, 1000);
        });
      `]
    });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    const first = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "first long run" }
    });
    const stopped = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/cancel` });
    const second = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "second steering turn" }
    });

    expect(first.statusCode).toBe(202);
    expect(stopped.statusCode).toBe(200);
    expect(second.statusCode).toBe(202);
    await waitForSessionWhere(
      app,
      sessionId,
      (candidate) => candidate.status === "running" && candidate.activeTurnId === second.json().turn.id,
      "second steering turn to become active"
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(detail.json().session).toEqual(expect.objectContaining({
      status: "running",
      activeTurnId: second.json().turn.id
    }));

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/cancel` });
    await app.close();
  });

  it("emits a settle-time coding_diff_updated for a Claude Code turn's file changes", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const runner = fileWritingRunner("claude_code", async (workspacePath) => {
      await writeFile(join(workspacePath, "README.md"), "# Workspace\nAdded by the turn\n");
      await writeFile(join(workspacePath, "created-by-turn.txt"), "new file\n");
    });
    const service = newAgentSessionService(registry, { claude_code: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    await service.startTurn({ sessionId: session.id, message: "change some files" });
    await waitForServiceSession(service, session.id, "idle");

    const events = eventBus.getRecentEvents();
    const diffEvent = events.find((event) => event.type === "coding_diff_updated");
    expect(diffEvent?.payload).toMatchObject({
      sessionId: session.id,
      runnerKind: "claude_code",
      files: expect.arrayContaining([
        // The pre-turn tree was clean, so the modified file's vs-HEAD counts
        // are turn-attributable; the created file is untracked, which numstat
        // does not cover, reported in the diff vocabulary as "added".
        { path: "README.md", status: "modified", additions: 1, deletions: 0 },
        { path: "created-by-turn.txt", status: "added" }
      ])
    });
    const types = events.map((event) => event.type);
    expect(types.indexOf("coding_diff_updated")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("coding_diff_updated")).toBeLessThan(types.indexOf("coding_turn_completed"));
  });

  it("does not synthesize a settle-time diff for a Codex turn", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const runner = fileWritingRunner("codex", async (workspacePath) => {
      await writeFile(join(workspacePath, "created-by-turn.txt"), "new file\n");
    });
    const service = newAgentSessionService(registry, { codex: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "codex" });
    await service.startTurn({ sessionId: session.id, message: "change some files" });
    await waitForServiceSession(service, session.id, "idle");

    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("coding_diff_updated");
  });

  it("reports a stopped Claude Code turn's partial writes before the cancelled event", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: selectedDirectory });
    const eventBus = new EventBus();
    const runner = writeThenHangRunner(async (workspacePath) => {
      await writeFile(join(workspacePath, "partial-work.txt"), "half done\n");
    });
    const service = newAgentSessionService(registry, { claude_code: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    await service.startTurn({ sessionId: session.id, message: "start long run" });
    await runner.wrote;

    await service.cancelTurn(session.id);
    await waitForServiceSession(service, session.id, "idle");

    const types = eventBus.getRecentEvents().map((event) => event.type);
    const diffEvent = eventBus.getRecentEvents().find((event) => event.type === "coding_diff_updated");
    expect(diffEvent?.payload).toMatchObject({
      files: [{ path: "partial-work.txt", status: "added" }]
    });
    expect(types.indexOf("coding_diff_updated")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("coding_diff_updated")).toBeLessThan(types.indexOf("coding_turn_cancelled"));
  });
});
