import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AgentSessionService } from "../src/agent/AgentSessionService";
import { AgentTurnContextAssembler } from "../src/agent/AgentTurnContextAssembler";
import { EventBus } from "../src/events/EventBus";
import { buildServer } from "../src/server";
import type { AgentSession, ServiceConfig } from "../src/domain/models";
import type { AgentRunner } from "../src/runner/AgentRunner";
import { PendingQuestionRequests } from "../src/runner/shared/PendingQuestionRequests";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";

const execFileAsync = promisify(execFile);

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-agent-sessions-"));
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
    codexArgs: ["-e", "process.stdin.on('data', chunk => process.stdout.write(`codex heard: ${chunk}`))"],
    codexRunnerProtocol: "exec",
    ...overrides
  };
};

describe("agent sessions", () => {
  it("creates a Codex session bound to a registered local workspace", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory, name: "Agent workspace" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex", title: "Vision turn" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      session: expect.objectContaining({
        id: expect.stringMatching(/^agent-session-/),
        workspaceId: registered.json().workspace.id,
        workspacePath: registered.json().workspace.path,
        runnerKind: "codex",
        title: "Vision turn",
        status: "idle",
        turnCount: 0
      })
    });

    const list = await app.inject({ method: "GET", url: "/api/agent-sessions" });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toEqual([response.json().session]);

    await app.close();
  });

  it("deletes an agent session and removes its message history", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, title: "Disposable thread" }
    });
    const sessionId = session.json().session.id;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "record this before deletion" }
    });
    await waitForSession(app, sessionId, "idle");

    const removed = await app.inject({ method: "DELETE", url: `/api/agent-sessions/${sessionId}` });
    const list = await app.inject({ method: "GET", url: "/api/agent-sessions" });
    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const logs = await app.inject({ method: "GET", url: "/api/logs" });

    expect(removed.statusCode).toBe(204);
    expect(list.json().sessions).toEqual([]);
    expect(detail.statusCode).toBe(404);
    expect(messages.statusCode).toBe(404);
    expect(logs.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent_session_deleted",
        payload: expect.objectContaining({
          sessionId,
          workspaceId: registered.json().workspace.id
        })
      })
    ]));

    await app.close();
  });

  it("deletes uploaded image attachments when deleting a session", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
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
    const attachmentDirectory = join(
      serviceConfig.stateDir,
      "attachments",
      registered.json().workspace.id,
      session.json().session.id,
      upload.json().attachment.id
    );
    await expect(readFile(join(attachmentDirectory, "source"))).resolves.toEqual(imageBytes);

    const removed = await app.inject({ method: "DELETE", url: `/api/agent-sessions/${session.json().session.id}` });

    expect(removed.statusCode).toBe(204);
    await expect(readFile(join(attachmentDirectory, "source"))).rejects.toMatchObject({ code: "ENOENT" });

    await app.close();
  });

  it("rejects sessions for unknown workspaces and unsupported runners", async () => {
    const serviceConfig = await config();
    const { app } = await buildServer({ config: serviceConfig });

    const unknownWorkspace = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: "workspace-missing", runnerKind: "codex" }
    });
    const unsupportedRunner = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: "workspace-missing", runnerKind: "claude" }
    });

    expect(unknownWorkspace.statusCode).toBe(404);
    expect(unknownWorkspace.json()).toEqual({ error: "Workspace is not registered" });
    expect(unsupportedRunner.statusCode).toBe(400);
    expect(unsupportedRunner.json()).toEqual({ error: "Invalid agent session payload" });

    await app.close();
  });

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

  it("stores uploaded image attachments under state dir for a session", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
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

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toEqual({
      attachment: expect.objectContaining({
        id: expect.stringMatching(/^attachment-/),
        workspaceId: registered.json().workspace.id,
        sessionId: session.json().session.id,
        kind: "image",
        sourceName: "clipboard.png",
        contentType: "image/png",
        sizeBytes: imageBytes.length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: expect.any(String)
      })
    });

    const attachment = upload.json().attachment;
    const directory = join(
      serviceConfig.stateDir,
      "attachments",
      registered.json().workspace.id,
      session.json().session.id,
      attachment.id
    );
    await expect(readFile(join(directory, "source"))).resolves.toEqual(imageBytes);
    await expect(readFile(join(directory, "metadata.json"), "utf8")).resolves.toContain("clipboard.png");

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

  it("rejects turns after the session workspace is unregistered", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
    await mkdir(join(selectedDirectory, ".git"));
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${registered.json().workspace.id}`
    });
    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "should not run after removal" }
    });

    expect(removed.statusCode).toBe(204);
    expect(turn.statusCode).toBe(404);
    expect(turn.json()).toEqual({ error: "Workspace is not registered" });

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

  it("binds new sessions to the current workspace branch and restores it before turns", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await createGitWorkspace();
    await git(selectedDirectory, "switch", "-c", "feature/session-branch");
    const { app } = await buildServer({ config: serviceConfig });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, title: "Feature branch thread" }
    });
    await git(selectedDirectory, "switch", "main");

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/turns`,
      payload: { message: "run on the thread branch" }
    });

    expect(session.statusCode).toBe(201);
    expect(session.json().session).toMatchObject({
      workspaceId: registered.json().workspace.id,
      gitBranch: "feature/session-branch"
    });
    expect(turn.statusCode).toBe(202);
    await waitForSession(app, session.json().session.id, "idle");
    await expect(git(selectedDirectory, "branch", "--show-current")).resolves.toBe("feature/session-branch\n");

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

  it("lets a client answer an outstanding permission request, and audits the decision", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-workspace-"));
    const runner = permissionAskingRunner();
    const { app, eventBus } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "delete everything" }
    });

    const requested = await waitForEvent(eventBus, "coding_permission_requested");
    // The client is given what it needs to offer a choice: the id an answer
    // addresses and the options the agent itself supplied.
    expect(requested.payload).toMatchObject({
      requestId: PERMISSION_REQUEST_ID,
      options: [
        { optionId: PERMISSION_ALLOW_OPTION_ID, kind: "allow_once", name: "Allow" },
        { optionId: "reject-1", kind: "reject_once", name: "Reject" }
      ],
      request: { title: "Run rm -rf /tmp/everything" }
    });

    const unknownOption = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/${PERMISSION_REQUEST_ID}`,
      payload: { optionId: "allow_always" }
    });
    expect(unknownOption.statusCode).toBe(400);

    const unknownRequest = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/permission-not-mine`,
      payload: { optionId: "allow-1" }
    });
    expect(unknownRequest.statusCode).toBe(404);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/permissions/${PERMISSION_REQUEST_ID}`,
      // Option ids are opaque. Leading/trailing whitespace must survive the
      // route unchanged so the value still matches what the runner offered.
      payload: { optionId: PERMISSION_ALLOW_OPTION_ID }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().session.id).toBe(sessionId);
    await waitForSession(app, sessionId, "idle");

    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    const entry = audit.json().events.find(
      (event: { type: string }) => event.type === "agent_permission_resolved"
    );
    // The decision is recorded; the request is not. A tool call an agent was
    // about to run can carry anything, and a durable log is the wrong place
    // for it.
    expect(entry).toMatchObject({
      sessionId,
      audit: {
        requestId: PERMISSION_REQUEST_ID,
        optionId: PERMISSION_ALLOW_OPTION_ID,
        decidedBy: "human",
        status: "selected"
      }
    });
    expect(JSON.stringify(entry)).not.toContain("rm -rf");

    await app.close();
  });

  it("refuses an unauthenticated permission answer when a token is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-auth-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: permissionAskingRunner() } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory },
      headers: { authorization: "Bearer secret-token" }
    });

    // Answering is a mutation like any other: the global preHandler gates it,
    // so authorizing an agent's action cannot be done by an unauthenticated
    // caller on the LAN.
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-missing/permissions/permission-1",
      payload: { optionId: "allow-1" }
    });
    expect(response.statusCode).toBe(401);
    expect(registered.statusCode).toBe(201);

    await app.close();
  });

  it("reports no outstanding request for a runner with no approval channel", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-permission-none-"));
    const runner = fileWritingRunner("codex", async () => {});
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { path: selectedDirectory }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });

    // A runner that never asks has nothing outstanding, which is the same
    // answer as an id that expired — the route reads no runner identity.
    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.json().session.id}/permissions/permission-1`,
      payload: { optionId: "allow-1" }
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("lets a client answer a clarifying-question batch, records the answer in the thread, and audits the decision", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-workspace-"));
    const runner = questionAskingRunner();
    const { app, eventBus, agentSessions } = await buildServer({ config: serviceConfig, runners: { codex: runner } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    let snapshotDuringRequest: ReturnType<AgentSessionService["listOutstandingQuestions"]> = undefined;
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "coding_question_requested") {
        snapshotDuringRequest = agentSessions.listOutstandingQuestions(sessionId);
      }
    });
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "build the thing" }
    });

    const requested = await waitForEvent(eventBus, "coding_question_requested");
    // The client is given what it needs to render the deck: the id an answer
    // addresses and every set with its minted option ids.
    expect(requested.payload).toMatchObject({
      requestId: QUESTION_REQUEST_ID,
      questionSets: [
        { setId: "set-1", header: "Platform", selection: "single", discussion: "optional" },
        { setId: "set-2", header: "Features", selection: "multiple", discussion: "none" }
      ]
    });
    expect(snapshotDuringRequest).toEqual([
      expect.objectContaining({ requestId: QUESTION_REQUEST_ID, questionSets: requested.payload.questionSets })
    ]);
    unsubscribe();

    // A late joiner can re-seed the same batch from the read route.
    const outstanding = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(outstanding.statusCode).toBe(200);
    expect(outstanding.json().questions).toEqual([
      expect.objectContaining({ requestId: QUESTION_REQUEST_ID, questionSets: requested.payload.questionSets })
    ]);

    const unknownOption = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-9"] }] }
    });
    expect(unknownOption.statusCode).toBe(400);
    expect(unknownOption.json().error).toBe("Question option was not offered for this set");

    const freeTextRefused = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [{ setId: "set-2", selectedOptionIds: ["opt-1"], discussion: "but also" }] }
    });
    expect(freeTextRefused.statusCode).toBe(400);

    const unknownRequest = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/question-not-mine`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"] }] }
    });
    expect(unknownRequest.statusCode).toBe(404);

    const emptyAnswer = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: { answers: [] }
    });
    expect(emptyAnswer.statusCode).toBe(400);

    const answered = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/${QUESTION_REQUEST_ID}`,
      payload: {
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first, please" },
          { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        ]
      }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().session.id).toBe(sessionId);
    await waitForSession(app, sessionId, "idle");

    const resolved = await waitForEvent(eventBus, "coding_question_resolved");
    expect(resolved.payload).toMatchObject({
      requestId: QUESTION_REQUEST_ID,
      status: "answered",
      decidedBy: "human",
      questionAnswers: [
        { setId: "set-1", selectedOptionIds: ["opt-2"], discussion: "phones first, please" },
        { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
      ]
    });

    // The answer is in the thread as the user message it is.
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const answerMessage = messages.json().messages.find(
      (message: { context?: { questionRequestId?: string } }) => message.context?.questionRequestId === QUESTION_REQUEST_ID
    );
    expect(answerMessage).toMatchObject({ role: "user", status: "sent" });
    expect(answerMessage.content).toContain("Platform: Which platform first?");
    expect(answerMessage.content).toContain("→ Mobile");
    expect(answerMessage.content).toContain("phones first, please");
    expect(answerMessage.content).toContain("→ Reminders, Sharing");

    // Durable audit keeps the decision — sets and option ids, on whose
    // authority — and never the person's free text.
    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    const entry = audit.json().events.find((event: { type: string }) => event.type === "agent_question_resolved");
    expect(entry).toMatchObject({
      sessionId,
      audit: {
        requestId: QUESTION_REQUEST_ID,
        status: "answered",
        decidedBy: "human",
        answers: [
          { setId: "set-1", selectedOptionIds: ["opt-2"] },
          { setId: "set-2", selectedOptionIds: ["opt-1", "opt-3"] }
        ]
      }
    });
    expect(JSON.stringify(entry)).not.toContain("phones first");

    // Settled, so the read route shows nothing outstanding.
    const drained = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(drained.json().questions).toEqual([]);

    await app.close();
  });

  it("cancels a question left open by a terminal runner path before publishing the terminal event", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-terminal-"));
    const { app, eventBus } = await buildServer({
      config: serviceConfig,
      runners: { codex: abandonedQuestionRunner() }
    });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "ask, then fail" }
    });
    await waitForSession(app, sessionId, "failed");

    const questions = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(questions.json().questions).toEqual([]);
    const relevant = eventBus.getRecentEvents().filter((event) =>
      event.type === "coding_question_requested"
      || event.type === "coding_question_resolved"
      || event.type === "coding_turn_failed"
    );
    expect(relevant.map((event) => event.type)).toEqual([
      "coding_question_requested",
      "coding_question_resolved",
      "coding_turn_failed"
    ]);
    expect(relevant[1]?.payload).toMatchObject({ requestId: QUESTION_REQUEST_ID, status: "cancelled" });

    await app.close();
  });

  it("gates the question answer and the outstanding read behind the bearer token when one is configured", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: questionAskingRunner() } });

    const answer = await app.inject({
      method: "POST",
      url: "/api/agent-sessions/agent-session-missing/questions/question-1",
      payload: { answers: [] }
    });
    expect(answer.statusCode).toBe(401);
    // The outstanding read returns model-authored text, so it is gated like
    // the transcript read rather than left open like the status snapshot.
    const read = await app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-missing/questions" });
    expect(read.statusCode).toBe(401);

    await app.close();
  });

  it("reports no outstanding question batch for a runner with no way to ask", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-question-none-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: fileWritingRunner("codex", async () => {}) } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, runnerKind: "codex" }
    });
    const sessionId = session.json().session.id as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/questions/question-1`,
      payload: { answers: [{ setId: "set-1", selectedOptionIds: ["opt-1"] }] }
    });
    expect(response.statusCode).toBe(404);
    const outstanding = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/questions` });
    expect(outstanding.json().questions).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions/nope/questions" })).statusCode).toBe(404);

    await app.close();
  });
});

async function waitForSession(app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> }, id: string, status: string): Promise<any> {
  return waitForSessionWhere(app, id, (session) => session?.status === status, `session ${id} to become ${status}`);
}

async function waitForSessionWhere(
  app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> },
  id: string,
  predicate: (session: any) => boolean,
  description: string
): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-sessions/${id}` });
    const session = response.json().session;
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForServiceSession(
  service: AgentSessionService,
  id: string,
  status: AgentSession["status"]
): Promise<AgentSession> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = service.getSession(id);
    if (session?.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for service session ${id} to become ${status}`);
}

function lateTokenUsageAfterCancelRunner(): AgentRunner & { completed: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    completed,
    async getCapabilities() {
      return {
        runnerKind: "codex",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run() {
      await cancelled;
      try {
        yield {
          type: "token_usage_updated",
          inputTokens: 123,
          cachedInputTokens: 23,
          outputTokens: 7,
          reasoningOutputTokens: 3,
          totalTokens: 130,
          modelContextWindowTokens: 258400
        };
        yield {
          type: "run_succeeded",
          message: "done"
        };
      } finally {
        complete();
      }
    },
    async cancel() {
      releaseCancel();
    }
  };
}

// Mirrors a runner whose cancel() resolves before the run() generator drains
// its final failure event, the ordering deleteSession must tolerate.
function lateFailureAfterCancelRunner(): AgentRunner & { completed: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    completed,
    async getCapabilities() {
      return {
        runnerKind: "codex",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run() {
      await cancelled;
      try {
        yield {
          type: "run_failed",
          error: "turn interrupted"
        };
      } finally {
        complete();
      }
    },
    async cancel() {
      releaseCancel();
    }
  };
}

function newAgentSessionService(
  registry: LocalWorkspaceRegistry,
  runners: Partial<Record<"codex" | "claude_code", AgentRunner>>,
  eventBus: EventBus
): AgentSessionService {
  return new AgentSessionService({
    registry,
    runners,
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
}

const PERMISSION_REQUEST_ID = "permission-test-1";
const PERMISSION_ALLOW_OPTION_ID = " allow-1 ";

/**
 * A runner that asks permission mid-turn and waits for the answer, the way an
 * ACP adapter under the `ask` posture does — without needing a child process.
 * The route and the audit record are what these tests are about; the adapter's
 * own wait is covered against the synthetic agent in `acpRunner.test.ts`.
 */
function permissionAskingRunner(): AgentRunner {
  const options = [
    { optionId: PERMISSION_ALLOW_OPTION_ID, kind: "allow_once", name: "Allow" },
    { optionId: "reject-1", kind: "reject_once", name: "Reject" }
  ];
  let answer!: (optionId: string) => void;
  const answered = new Promise<string>((resolve) => {
    answer = resolve;
  });
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_permission_request",
          title: "Run rm -rf /tmp/everything",
          content: {},
          canonical: {
            kind: "permission_requested",
            requestId: PERMISSION_REQUEST_ID,
            options,
            request: { title: "Run rm -rf /tmp/everything", command: "rm -rf /tmp/everything" }
          }
        }
      };
      const optionId = await answered;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_permission_resolved",
          title: "Run rm -rf /tmp/everything",
          content: {},
          canonical: {
            kind: "permission_resolved",
            requestId: PERMISSION_REQUEST_ID,
            status: "selected",
            optionId,
            decidedBy: "human"
          }
        }
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {},
    answerPermissionRequest(input) {
      if (input.requestId !== PERMISSION_REQUEST_ID) return "unknown_request";
      if (!options.some((option) => option.optionId === input.optionId)) return "unknown_option";
      answer(input.optionId);
      return "answered";
    }
  };
}

const QUESTION_REQUEST_ID = "question-test-1";
const QUESTION_SETS = [
  {
    setId: "set-1",
    header: "Platform",
    prompt: "Which platform first?",
    selection: "single" as const,
    options: [
      { optionId: "opt-1", label: "Web" },
      { optionId: "opt-2", label: "Mobile", description: "iOS and Android" }
    ],
    discussion: "optional" as const
  },
  {
    setId: "set-2",
    header: "Features",
    prompt: "Which features matter?",
    selection: "multiple" as const,
    options: [
      { optionId: "opt-1", label: "Reminders" },
      { optionId: "opt-2", label: "Tags" },
      { optionId: "opt-3", label: "Sharing" }
    ],
    discussion: "none" as const
  }
];

/**
 * A runner that pauses mid-turn to ask a clarifying-question batch and waits
 * for the answer, the way the Claude Code adapter does through the SDK
 * callback — without a child process. Validation is the shared store's rule,
 * reused so the route's refusals are the real ones.
 */
function questionAskingRunner(): AgentRunner {
  const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      const sessionKey = input.sessionId ?? input.runId;
      const wait = pending.wait({ sessionKey, requestId: QUESTION_REQUEST_ID, sets: QUESTION_SETS })!;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_requested",
          title: "Questions for you",
          content: {},
          canonical: { kind: "question_requested", requestId: QUESTION_REQUEST_ID, questionSets: QUESTION_SETS }
        }
      };
      const outcome = await wait;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_resolved",
          title: "Questions answered",
          content: {},
          canonical: {
            kind: "question_resolved",
            requestId: QUESTION_REQUEST_ID,
            status: outcome.status,
            ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
            ...(outcome.status === "answered" ? { questionAnswers: outcome.answers } : {})
          }
        }
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {},
    answerQuestionRequest(input) {
      return pending.answer(input.sessionId, input.requestId, input.answers);
    }
  };
}

/** A child-loss shape: the request was published, but no resolution survived. */
function abandonedQuestionRunner(): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_requested",
          title: "Questions for you",
          content: {},
          canonical: { kind: "question_requested", requestId: QUESTION_REQUEST_ID, questionSets: QUESTION_SETS }
        }
      };
      yield { type: "run_failed", error: "child exited" };
    },
    async cancel() {}
  };
}

async function waitForEvent(
  eventBus: EventBus,
  type: string,
  timeoutMs = 5_000
): Promise<{ type: string; payload: any }> {
  const startedAt = Date.now();
  for (;;) {
    const event = eventBus.getRecentEvents(200).find((candidate) => candidate.type === type);
    if (event) return event;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fileWritingRunner(
  runnerKind: "codex" | "claude_code",
  write: (workspacePath: string) => Promise<void>
): AgentRunner {
  return {
    async getCapabilities() {
      return {
        runnerKind,
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run(input) {
      await write(input.workspacePath);
      yield {
        type: "run_succeeded",
        message: "done"
      };
    },
    async cancel() {}
  };
}

function writeThenHangRunner(write: (workspacePath: string) => Promise<void>): AgentRunner & { wrote: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let markWrote!: () => void;
  const wrote = new Promise<void>((resolve) => {
    markWrote = resolve;
  });
  return {
    wrote,
    async getCapabilities() {
      return {
        runnerKind: "claude_code",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run(input) {
      await write(input.workspacePath);
      markWrote();
      await cancelled;
    },
    async cancel() {
      releaseCancel();
    }
  };
}

async function createGitWorkspace(): Promise<string> {
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-git-workspace-"));
  await git(selectedDirectory, "init", "-b", "main");
  await git(selectedDirectory, "config", "user.email", "agentroom@example.invalid");
  await git(selectedDirectory, "config", "user.name", "AgentRoom Tests");
  await writeFile(join(selectedDirectory, "README.md"), "# Workspace\n");
  await git(selectedDirectory, "add", "README.md");
  await git(selectedDirectory, "commit", "-m", "Initial commit");
  return selectedDirectory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function multipartFilePayload(input: {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `agentroom-test-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.filename}"`,
    `Content-Type: ${input.contentType}`,
    "",
    ""
  ].join("\r\n"));
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([prefix, input.data, suffix])
  };
}

async function writeCompletingJsonRpcServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-agent-sessions-jsonrpc-"));
  const path = join(root, "fake-completing-codex.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-agent-sessions",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-agent-sessions",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-agent-sessions", turn: currentTurn } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-agent-sessions", turn: { ...currentTurn, status: "completed" } } });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

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

/**
 * A runner that reports a native session id at start and records the seeds the
 * service hands it, the way the four host-backed adapters do — without a child
 * process. Which id it reports is the test's choice, so a resume the runner
 * did not honor can be simulated by reporting a different one.
 */
function nativeSessionRunner(
  nativeSessionId: string,
  options: { seeds?: Array<{ sessionId: string; nativeSessionId: string; interrupted: boolean }> } = {}
): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_session_started",
          title: "Session started",
          content: {},
          canonical: { kind: "session_started" },
          runner: { nativeSessionId, model: "test-model", cwd: "/tmp/workspace" }
        }
      };
      yield { type: "run_succeeded", message: "noted" };
    },
    async cancel() {},
    ...(options.seeds
      ? {
          rememberResumableId(input: { sessionId: string; nativeSessionId: string; interrupted: boolean }) {
            options.seeds?.push({ ...input });
          }
        }
      : {})
  };
}

function nativeSessionSequenceRunner(nativeSessionIds: Array<string | undefined>): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      for (const nativeSessionId of nativeSessionIds) {
        yield {
          type: "agent_activity" as const,
          activity: {
            kind: "test_session_started",
            title: "Session started",
            content: {},
            canonical: { kind: "session_started" as const },
            runner: {
              ...(nativeSessionId ? { nativeSessionId } : {}),
              model: "test-model",
              cwd: "/tmp/workspace"
            }
          }
        };
      }
      yield { type: "run_succeeded" as const, message: "noted" };
    },
    async cancel() {}
  };
}

/** Register a workspace through the registry alone, before any server is built. */
async function registerWorkspaceOffline(serviceConfig: ServiceConfig): Promise<{ id: string; path: string }> {
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const registered = await registry.register({ path: selectedDirectory });
  return { id: registered.workspace.id, path: registered.workspace.path };
}

async function writeSessionDocument(serviceConfig: ServiceConfig, document: Record<string, unknown>): Promise<void> {
  const directory = join(serviceConfig.stateDir, "sessions");
  await mkdir(directory, { recursive: true });
  const session = document.session as { id: string };
  await writeFile(join(directory, `${session.id}.json`), JSON.stringify(document));
}

/** A version-1 session document as the store writes it, with one settled turn. */
function sessionDocument(
  sessionId: string,
  workspace: { id: string; path: string },
  options: { runnerKind: string; nativeSessionId?: string; running?: boolean }
): Record<string, unknown> {
  const turnId = `turn-${sessionId}`;
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      runnerKind: options.runnerKind,
      ...(options.nativeSessionId ? { runner: { nativeSessionId: options.nativeSessionId } } : {}),
      status: options.running ? "running" : "idle",
      ...(options.running ? { activeTurnId: turnId } : {}),
      turnCount: options.running ? 0 : 1,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:10.000Z"
    },
    turns: [
      {
        id: turnId,
        sessionId,
        status: options.running ? "running" : "succeeded",
        startedAt: "2026-08-26T00:00:00.000Z",
        ...(options.running ? {} : { completedAt: "2026-08-26T00:00:10.000Z" }),
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    ],
    messages: [
      {
        id: `message-${sessionId}-user`,
        sessionId,
        turnId,
        role: "user",
        content: "hello",
        status: "sent",
        at: "2026-08-26T00:00:00.000Z"
      },
      {
        id: `message-${sessionId}-assistant`,
        sessionId,
        turnId,
        role: "assistant",
        content: options.running ? "partial" : "hi",
        status: options.running ? "running" : "succeeded",
        at: "2026-08-26T00:00:10.000Z"
      }
    ]
  };
}

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
