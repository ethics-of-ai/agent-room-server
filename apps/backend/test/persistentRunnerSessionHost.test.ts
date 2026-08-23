import { describe, expect, it } from "vitest";
import {
  PersistentRunnerSessionHost,
  type PersistentRunnerSessionHostOptions,
  type RunnerRestoreStrategy
} from "../src/runner/shared/PersistentRunnerSessionHost";

interface FakeSession {
  readonly key: string;
  readonly id: string;
  busy: boolean;
  reusable: boolean;
  tornDown: boolean;
}

function makeHost(
  overrides: Partial<PersistentRunnerSessionHostOptions<FakeSession>> & {
    restoreStrategy?: RunnerRestoreStrategy;
  } = {}
): { host: PersistentRunnerSessionHost<FakeSession>; teardowns: string[] } {
  const teardowns: string[] = [];
  const host = new PersistentRunnerSessionHost<FakeSession>({
    runnerKind: "codex",
    restoreStrategy: overrides.restoreStrategy ?? "native_resume",
    idleSessionTimeoutMs: overrides.idleSessionTimeoutMs ?? 60,
    teardown: (session) => {
      session.tornDown = true;
      teardowns.push(session.id);
    },
    isBusy: (session) => session.busy,
    isReusable: (session) => session.reusable,
    ...(overrides.describe ? { describe: overrides.describe } : {})
  });
  return { host, teardowns };
}

function makeSession(key: string, id = key): FakeSession {
  return { key, id, busy: false, reusable: true, tornDown: false };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PersistentRunnerSessionHost", () => {
  it("hands back a registered session and drops one that is no longer reusable", () => {
    const { host, teardowns } = makeHost();
    const session = makeSession("session-a");
    host.register(session);

    expect(host.acquire("session-a")).toBe(session);

    // A dead child is dropped from the registry so the caller spawns a fresh
    // one — but it is not torn down, because there is nothing left to kill.
    session.reusable = false;
    expect(host.acquire("session-a")).toBeUndefined();
    expect(teardowns).toEqual([]);
    expect(host.acquire("session-a")).toBeUndefined();
  });

  it("idle-reaps a quiet session and keeps its resumable id", async () => {
    const { host, teardowns } = makeHost({ idleSessionTimeoutMs: 40 });
    const session = makeSession("session-idle");
    host.register(session);
    host.rememberResumableId("session-idle", "native-thread-1");

    await delay(140);

    expect(teardowns).toEqual(["session-idle"]);
    expect(host.acquire("session-idle")).toBeUndefined();
    // The whole point of reaping: the conversation is restorable next turn.
    expect(host.resumableId("session-idle")).toBe("native-thread-1");
  });

  it("never reaps a session while a turn is in flight", async () => {
    const { host, teardowns } = makeHost({ idleSessionTimeoutMs: 40 });
    const session = makeSession("session-busy");
    session.busy = true;
    host.register(session);

    await delay(140);
    expect(teardowns).toEqual([]);

    // Once the turn settles the deadline resumes from the last activity touch.
    session.busy = false;
    host.touch(session);
    await delay(140);
    expect(teardowns).toEqual(["session-busy"]);
  });

  it("defers the reap deadline when activity is touched", async () => {
    const { host, teardowns } = makeHost({ idleSessionTimeoutMs: 60 });
    const session = makeSession("session-touched");
    host.register(session);

    for (let i = 0; i < 4; i += 1) {
      await delay(30);
      host.touch(session);
    }
    expect(teardowns).toEqual([]);

    await delay(200);
    expect(teardowns).toEqual(["session-touched"]);
  });

  it("never reaps or remembers a resume id for an unsupported restore strategy", async () => {
    const { host, teardowns } = makeHost({ restoreStrategy: "unsupported", idleSessionTimeoutMs: 40 });
    const session = makeSession("session-unrestorable");
    host.register(session);
    host.rememberResumableId("session-unrestorable", "native-thread-2");

    await delay(140);

    // Reaping a child that cannot be restored would silently start a fresh
    // conversation under the same AgentRoom session id.
    expect(teardowns).toEqual([]);
    expect(host.acquire("session-unrestorable")).toBe(session);
    expect(host.restorable).toBe(false);
    expect(host.resumableId("session-unrestorable")).toBeUndefined();
  });

  it("forgets the resumable id when the AgentRoom session is closed", () => {
    const { host, teardowns } = makeHost();
    const session = makeSession("session-closed");
    host.register(session);
    host.rememberResumableId("session-closed", "native-thread-3");

    host.close("session-closed");

    expect(teardowns).toEqual(["session-closed"]);
    // An explicitly deleted thread must never be silently resumed.
    expect(host.resumableId("session-closed")).toBeUndefined();
    expect(host.acquire("session-closed")).toBeUndefined();
  });

  it("closes a key whose child is already gone", () => {
    const { host, teardowns } = makeHost();
    host.rememberResumableId("session-gone", "native-thread-4");

    host.close("session-gone");

    expect(teardowns).toEqual([]);
    expect(host.resumableId("session-gone")).toBeUndefined();
  });

  it("tears a displaced session down instead of leaking its child", async () => {
    const { host, teardowns } = makeHost({ idleSessionTimeoutMs: 40 });
    const previous = makeSession("session-shared", "previous");
    const replacement = makeSession("session-shared", "replacement");
    host.register(previous);

    // An adapter that races its own acquire-then-spawn path would otherwise
    // leave `previous` running with nothing holding a reference to it.
    host.register(replacement);
    expect(teardowns).toEqual(["previous"]);
    expect(previous.tornDown).toBe(true);
    expect(host.acquire("session-shared")).toBe(replacement);

    // Displacement also cancelled the previous entry's timer, so only the live
    // session is ever reaped.
    await delay(140);
    expect(teardowns).toEqual(["previous", "replacement"]);
  });

  it("release and destroy from a stale session never evict the current entry", () => {
    const { host, teardowns } = makeHost();
    const previous = makeSession("session-shared", "previous");
    const replacement = makeSession("session-shared", "replacement");
    host.register(previous);
    host.register(replacement);

    // A late `close`/`error` handler from the replaced child must not evict the
    // session that took its place, and neither must a `destroy` from a caller
    // still holding the stale reference (teardown is idempotent by contract).
    host.release(previous);
    expect(host.acquire("session-shared")).toBe(replacement);

    host.destroy(previous);
    expect(host.acquire("session-shared")).toBe(replacement);
    expect(replacement.tornDown).toBe(false);
    expect(teardowns.filter((id) => id === "replacement")).toEqual([]);
  });

  it("tears every session down and forgets every resume id on dispose", async () => {
    const { host, teardowns } = makeHost({ idleSessionTimeoutMs: 40 });
    const first = makeSession("session-1");
    const second = makeSession("session-2");
    host.register(first);
    host.register(second);
    host.rememberResumableId("session-1", "native-thread-5");

    host.disposeAll();

    expect(teardowns.sort()).toEqual(["session-1", "session-2"]);
    expect(host.resumableId("session-1")).toBeUndefined();
    expect(host.acquire("session-1")).toBeUndefined();

    // Disposal also cancels the idle timers rather than leaving them to fire
    // against a cleared registry.
    await delay(140);
    expect(teardowns).toHaveLength(2);
  });
});
