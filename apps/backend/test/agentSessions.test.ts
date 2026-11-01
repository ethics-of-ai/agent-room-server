import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import {
  config,
  createGitWorkspace,
  git,
  multipartFilePayload,
  waitForSession
} from "./support/agentSessionHarness";

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

  it("titles an untitled thread from its first person turn and keeps that title", async () => {
    const { app, created } = await serverWithThread();
    const sessionId = created.json().session.id;
    expect(created.json().session.title).toBeUndefined();

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "# Fix the login loop\nIt redirects forever." } });
    await expect(waitForSession(app, sessionId, "idle")).resolves.toMatchObject({ title: "Fix the login loop" });
    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "Now add a test" } });
    await expect(waitForSession(app, sessionId, "idle")).resolves.toMatchObject({ title: "Fix the login loop" });

    await app.close();
  });

  it("keeps a title given at creation over the first turn's line", async () => {
    const { app, created } = await serverWithThread({ title: "Chosen title" });
    const sessionId = created.json().session.id;

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "Something else entirely" } });
    await expect(waitForSession(app, sessionId, "idle")).resolves.toMatchObject({ title: "Chosen title" });

    await app.close();
  });

  it("refuses a creation title over the thread title cap", async () => {
    const { app, workspaceId, created } = await serverWithThread({ title: "x".repeat(121) });
    const atCap = await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId, title: "x".repeat(120) } });

    expect(created.statusCode).toBe(400);
    expect(atCap.statusCode).toBe(201);

    await app.close();
  });

  it("leaves a thread untitled when its first turn is refused", async () => {
    const { app, workspaceId, created } = await serverWithThread();
    const sessionId = created.json().session.id;
    await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}` });

    const turn = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "never runs" } });
    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });

    expect(turn.statusCode).toBe(404);
    expect(detail.json().session.title).toBeUndefined();

    await app.close();
  });

  it("records the current branch on new sessions and runs turns on the machine's branch", async () => {
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
      payload: { message: "run on whatever branch the Mac is on" }
    });

    expect(session.statusCode).toBe(201);
    expect(session.json().session).toMatchObject({
      workspaceId: registered.json().workspace.id,
      gitBranch: "feature/session-branch"
    });
    expect(turn.statusCode).toBe(202);
    // The person switched to main after creating the thread; the turn runs there
    // and the thread records it, instead of switching back.
    await expect(waitForSession(app, session.json().session.id, "idle")).resolves.toMatchObject({ gitBranch: "main" });
    await expect(git(selectedDirectory, "branch", "--show-current")).resolves.toBe("main\n");

    await app.close();
  });
});

/** A fresh server with one registered plain-folder workspace and a thread created in it with `payload`. */
async function serverWithThread(payload: Record<string, unknown> = {}) {
  const { app } = await buildServer({ config: await config() });
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
  const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
  const workspaceId: string = registered.json().workspace.id;
  const created = await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId, ...payload } });
  return { app, workspaceId, created };
}
