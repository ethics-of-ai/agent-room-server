import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableAgentSessionDocument } from "../src/domain/models";
import { DurableAgentSessionStore, migrateDurableAgentSessionDocument } from "../src/state/DurableAgentSessionStore";

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-sessions-"));
  return join(root, ".state");
}

function document(sessionId: string, overrides: Partial<DurableAgentSessionDocument> = {}): DurableAgentSessionDocument {
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      workspaceId: "workspace-1",
      workspacePath: "/tmp/agentroom/workspace",
      runnerKind: "codex",
      runner: { nativeSessionId: `native-${sessionId}` },
      status: "idle",
      turnCount: 1,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:10.000Z"
    },
    turns: [
      {
        id: `turn-${sessionId}`,
        sessionId,
        status: "succeeded",
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: "2026-08-26T00:00:10.000Z",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    ],
    messages: [
      {
        id: `message-${sessionId}-user`,
        sessionId,
        turnId: `turn-${sessionId}`,
        role: "user",
        content: "hello",
        status: "sent",
        at: "2026-08-26T00:00:00.000Z"
      },
      {
        id: `message-${sessionId}-assistant`,
        sessionId,
        turnId: `turn-${sessionId}`,
        role: "assistant",
        content: "hi",
        status: "succeeded",
        at: "2026-08-26T00:00:10.000Z"
      }
    ],
    ...overrides
  };
}

describe("DurableAgentSessionStore", () => {
  it("round-trips documents across store instances", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    const first = document("agent-session-1");
    const second = document("agent-session-2");
    await store.schedule(first.session.id, () => first);
    await store.schedule(second.session.id, () => second);
    await store.flush();

    const restarted = new DurableAgentSessionStore({ stateDir: dir });
    const inventory = await restarted.initialize();
    expect(inventory.unsupported).toBe(0);
    expect(inventory.unreadable).toBe(0);
    expect(inventory.migrated).toBe(0);
    expect(inventory.documents.map((entry) => entry.session.id).sort()).toEqual([
      "agent-session-1",
      "agent-session-2"
    ]);
    expect(inventory.documents.find((entry) => entry.session.id === first.session.id)).toEqual(first);
  });

  it("creates the directory private to the operator", async () => {
    const dir = await stateDir();
    await new DurableAgentSessionStore({ stateDir: dir }).initialize();
    const info = await stat(join(dir, "sessions"));
    expect(info.mode & 0o777).toBe(0o700);
  });

  it("coalesces marks that land during a write and keeps the newest state", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    let snapshots = 0;
    let content = "";
    const snapshot = () => {
      snapshots += 1;
      return document("agent-session-1", {
        messages: [
          {
            id: "message-1",
            sessionId: "agent-session-1",
            role: "assistant",
            content,
            status: "running",
            at: "2026-08-26T00:00:00.000Z"
          }
        ]
      });
    };
    for (let index = 0; index < 50; index += 1) {
      content += "x";
      void store.schedule("agent-session-1", snapshot);
    }
    await store.flush();

    // One write was in flight when the first mark landed; every later mark
    // collapsed into at most one follow-up. The snapshot count is the write
    // count, because the snapshot is taken at write time.
    expect(snapshots).toBeLessThanOrEqual(2);
    const written = JSON.parse(await readFile(join(dir, "sessions", "agent-session-1.json"), "utf8")) as DurableAgentSessionDocument;
    expect(written.messages[0]?.content).toBe("x".repeat(50));
  });

  it("publishes atomically and ignores a leftover temp file", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    await store.schedule("agent-session-1", () => document("agent-session-1"));
    await store.flush();
    expect(await readdir(join(dir, "sessions"))).toEqual(["agent-session-1.json"]);

    await writeFile(join(dir, "sessions", "agent-session-2.json.tmp"), "{ partial");
    const inventory = await new DurableAgentSessionStore({ stateDir: dir }).initialize();
    expect(inventory.documents.map((entry) => entry.session.id)).toEqual(["agent-session-1"]);
    expect(inventory.unreadable).toBe(0);
  });

  it("leaves a newer schema version untouched and counts it as unsupported", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "sessions"), { recursive: true });
    const path = join(dir, "sessions", "agent-session-future.json");
    const bytes = JSON.stringify({ schemaVersion: 2, session: { id: "agent-session-future" }, future: true });
    await writeFile(path, bytes);

    const store = new DurableAgentSessionStore({ stateDir: dir });
    const inventory = await store.initialize();
    await store.schedule("agent-session-1", () => document("agent-session-1"));
    await store.flush();

    expect(inventory.unsupported).toBe(1);
    expect(inventory.unreadable).toBe(0);
    expect(inventory.documents).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("leaves unreadable documents in place while their siblings load", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "sessions"), { recursive: true });
    const notJson = join(dir, "sessions", "agent-session-broken.json");
    await writeFile(notJson, "{ not json");
    const missingFields = join(dir, "sessions", "agent-session-partial.json");
    await writeFile(missingFields, JSON.stringify({ schemaVersion: 1, session: { id: "agent-session-partial" } }));
    const misfiled = join(dir, "sessions", "agent-session-misfiled.json");
    await writeFile(misfiled, JSON.stringify(document("agent-session-elsewhere")));
    const good = join(dir, "sessions", "agent-session-good.json");
    await writeFile(good, JSON.stringify(document("agent-session-good")));

    const inventory = await new DurableAgentSessionStore({ stateDir: dir }).initialize();
    expect(inventory.unreadable).toBe(3);
    expect(inventory.unsupported).toBe(0);
    expect(inventory.documents.map((entry) => entry.session.id)).toEqual(["agent-session-good"]);
    for (const path of [notJson, missingFields, misfiled]) {
      await expect(stat(path)).resolves.toBeDefined();
    }
  });

  it("treats a version below the migration floor as unreadable, distinct from a newer one", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "sessions"), { recursive: true });
    const belowFloor = join(dir, "sessions", "agent-session-zero.json");
    const belowFloorBytes = JSON.stringify({ ...document("agent-session-zero"), schemaVersion: 0 });
    await writeFile(belowFloor, belowFloorBytes);
    const notInteger = join(dir, "sessions", "agent-session-string-version.json");
    await writeFile(notInteger, JSON.stringify({ ...document("agent-session-string-version"), schemaVersion: "1" }));
    const newer = join(dir, "sessions", "agent-session-newer.json");
    await writeFile(newer, JSON.stringify({ ...document("agent-session-newer"), schemaVersion: 99 }));

    const inventory = await new DurableAgentSessionStore({ stateDir: dir }).initialize();
    // Their repairs differ: a newer file is repaired by updating the app, an
    // unreadable one by the operator. Both are left exactly as written.
    expect(inventory.unreadable).toBe(2);
    expect(inventory.unsupported).toBe(1);
    expect(inventory.migrated).toBe(0);
    expect(inventory.documents).toEqual([]);
    expect(await readFile(belowFloor, "utf8")).toBe(belowFloorBytes);
  });

  it("passes a document at this version through the migration step untouched", () => {
    // Version 1 has no predecessor, so the step is the identity today. It is
    // exercised here so the first real migration has a test to extend rather
    // than a reader to restructure.
    const current = document("agent-session-current") as unknown as Record<string, unknown>;
    expect(migrateDurableAgentSessionDocument(current)).toEqual({ document: current, migrated: false });
    expect(migrateDurableAgentSessionDocument({ ...current, schemaVersion: 0 })).toBeUndefined();
    expect(migrateDurableAgentSessionDocument({ ...current, schemaVersion: 1.5 })).toBeUndefined();
    expect(migrateDurableAgentSessionDocument({ ...current, schemaVersion: 2 })).toBeUndefined();
  });

  it("reads a document whose runner is not registered in this process", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "sessions"), { recursive: true });
    const foreign = document("agent-session-acp");
    foreign.session.runnerKind = "acp_retired_agent";
    await writeFile(join(dir, "sessions", "agent-session-acp.json"), JSON.stringify(foreign));

    const inventory = await new DurableAgentSessionStore({ stateDir: dir }).initialize();
    expect(inventory.documents.map((entry) => entry.session.runnerKind)).toEqual(["acp_retired_agent"]);
  });

  it("removes a document and drops a write queued before the removal", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    await store.schedule("agent-session-1", () => document("agent-session-1"));
    await store.flush();
    await store.remove("agent-session-1");
    expect(await readdir(join(dir, "sessions"))).toEqual([]);

    // A mark still in flight when the delete arrives must not resurrect the file.
    void store.schedule("agent-session-2", () => document("agent-session-2"));
    void store.schedule("agent-session-2", () => document("agent-session-2"));
    await store.remove("agent-session-2");
    await store.flush();
    expect(await readdir(join(dir, "sessions"))).toEqual([]);
  });

  it("keeps a removed session tombstoned against late persistence marks", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    const sessionId = "agent-session-late-mark";

    const firstWrite = store.schedule(sessionId, () => document(sessionId));
    const lateWrite = firstWrite.then(() => store.schedule(sessionId, () => document(sessionId)));
    const removal = store.remove(sessionId);
    await Promise.all([removal, lateWrite]);
    await store.flush();

    expect(await readdir(join(dir, "sessions"))).toEqual([]);

    // Session ids are unique. Once deletion has completed, a drained runner
    // event for the old id must still be unable to recreate its document.
    await store.schedule(sessionId, () => document(sessionId));
    await store.flush();
    expect(await readdir(join(dir, "sessions"))).toEqual([]);
  });

  it("retries a failed write on the next mark", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    // A directory where the temp file goes makes the write fail.
    const tmp = join(dir, "sessions", "agent-session-1.json.tmp");
    await mkdir(tmp);
    await store.schedule("agent-session-1", () => document("agent-session-1"));
    await store.flush();
    expect(await readdir(join(dir, "sessions"))).toEqual(["agent-session-1.json.tmp"]);

    await rm(tmp, { recursive: true });
    await store.schedule("agent-session-1", () => document("agent-session-1"));
    await store.flush();
    expect(await readdir(join(dir, "sessions"))).toEqual(["agent-session-1.json"]);
  });

  it("refuses a session id that is not a plain file name", async () => {
    const dir = await stateDir();
    const store = new DurableAgentSessionStore({ stateDir: dir });
    await store.initialize();
    expect(() => store.schedule("../escape", () => document("../escape"))).toThrow(/not a valid document name/);
    await expect(store.remove(".hidden")).rejects.toThrow(/not a valid document name/);
  });
});
