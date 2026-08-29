import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events/EventBus";
import { FileAuditLogStore } from "../src/state/FileAuditLogStore";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-audit-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    editorCatalogDir: join(root, ".catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

describe("FileAuditLogStore", () => {
  it("persists bounded audit entries across store instances", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig, { maxEntries: 2 });
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("agent_session_created", {
      session: {
        id: "session-1",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/agentroom/workspace",
        runnerKind: "codex",
        title: "Vision session",
        status: "idle",
        turnCount: 0,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z"
      }
    });
    eventBus.publish("agent_turn_started", { sessionId: "session-1", turnId: "turn-1", workspacePath: "/tmp/agentroom/workspace" });
    eventBus.publish("agent_turn_succeeded", { sessionId: "session-1", turnId: "turn-1" });
    await store.flush();

    const restartedStore = new FileAuditLogStore(serviceConfig, { maxEntries: 2 });
    await restartedStore.initialize();

    expect(restartedStore.getRecent(10)).toEqual([
      expect.objectContaining({
        type: "agent_turn_started",
        sessionId: "session-1",
        workspacePath: "/tmp/agentroom/workspace"
      }),
      expect.objectContaining({
        type: "agent_turn_succeeded",
        sessionId: "session-1"
      })
    ]);
  });

  it("stores a sanitized audit profile without raw status snapshots", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig);
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("status_snapshot", { snapshot: { secret: "ignore-me" } });
    eventBus.publish("agent_session_created", {
      session: {
        id: "session-1",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/agentroom/workspace",
        runnerKind: "codex",
        title: "Durable audit",
        status: "idle",
        turnCount: 0,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z"
      }
    });
    await store.flush();

    const entries = store.getRecent(10);
    expect(entries).toEqual([
      expect.objectContaining({
        type: "agent_session_created",
        sessionId: "session-1",
        title: "Durable audit"
      })
    ]);
    expect(JSON.stringify(entries)).not.toContain("ignore-me");
  });

  it("keeps workspace path metadata for workspace audit timelines", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig);
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("agent_turn_started", { sessionId: "session-1", turnId: "turn-1", workspacePath: "/tmp/agentroom/project" });
    await store.flush();

    expect(store.getRecent(10)).toEqual([
      expect.objectContaining({
        type: "agent_turn_started",
        sessionId: "session-1",
        workspacePath: "/tmp/agentroom/project"
      })
    ]);
  });

  it("persists file deletion as workspace metadata without file content", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig);
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("workspace_file_deleted", {
      workspaceId: "workspace-1",
      workspacePath: "/tmp/agentroom/project",
      path: "notes/private.md",
      sizeBytes: 42
    });
    await store.flush();

    const entries = store.getRecent(10);
    expect(entries).toEqual([
      expect.objectContaining({
        type: "workspace_file_deleted",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/agentroom/project"
      })
    ]);
    expect(JSON.stringify(entries)).not.toContain("notes/private.md");
  });

  it("persists rename and directory deletion without their relative paths", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig);
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("workspace_entry_renamed", {
      workspaceId: "workspace-1",
      workspacePath: "/tmp/agentroom/project",
      oldPath: "private/old.md",
      path: "private/new.md",
      entryType: "file"
    });
    eventBus.publish("workspace_directory_deleted", {
      workspaceId: "workspace-1",
      workspacePath: "/tmp/agentroom/project",
      path: "private/archive",
      fileCount: 4,
      directoryCount: 2,
      sizeBytes: 128
    });
    await store.flush();

    const entries = store.getRecent(10);
    expect(entries.map((entry) => entry.type)).toEqual([
      "workspace_entry_renamed",
      "workspace_directory_deleted"
    ]);
    expect(entries.every((entry) => entry.workspaceId === "workspace-1")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("private/");
  });

  it("does not persist raw agent update messages", async () => {
    const serviceConfig = await config();
    const eventBus = new EventBus();
    const store = new FileAuditLogStore(serviceConfig);
    await store.initialize();
    store.attach(eventBus);

    eventBus.publish("agent_turn_update", {
      sessionId: "session-1",
      turnId: "turn-1",
      message: "stdout included token=secret-value"
    });
    eventBus.publish("agent_turn_started", { sessionId: "session-1", turnId: "turn-1" });
    await store.flush();

    const restartedStore = new FileAuditLogStore(serviceConfig);
    await restartedStore.initialize();
    const entries = restartedStore.getRecent(10);

    expect(entries).toEqual([
      expect.objectContaining({
        type: "agent_turn_started",
        sessionId: "session-1"
      })
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-value");
  });
});

describe("audit API", () => {
  it("exposes durable audit entries after server restart", async () => {
    const serviceConfig = await config();
    const first = await buildServer({ config: serviceConfig });
    first.eventBus.publish("agent_turn_started", { sessionId: "session-1", turnId: "turn-1", workspacePath: "/tmp/agentroom/project" });
    await first.auditLogStore.flush();
    await first.app.close();

    const restarted = await buildServer({ config: serviceConfig });
    const response = await restarted.app.inject({ method: "GET", url: "/api/audit" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        expect.objectContaining({
          type: "agent_turn_started",
          sessionId: "session-1",
          workspacePath: "/tmp/agentroom/project"
        })
      ]
    });

    await restarted.app.close();
  });
});
