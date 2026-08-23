import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { LocalWorkspace } from "../src/domain/models";
import type { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import {
  TerminalSessionError,
  TerminalSessionService,
  type TerminalProcess,
  type TerminalSpawnOptions
} from "../src/terminal/TerminalSessionService";

interface FakePty extends TerminalProcess {
  options: TerminalSpawnOptions;
  written: string[];
  resized: Array<{ cols: number; rows: number }>;
  killed: boolean;
  killSignal?: string;
  paused: boolean;
  // When set, resize throws — simulates node-pty's ioctl EBADF on an exited PTY.
  resizeThrows: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

function makeSpawner(): { spawner: (o: TerminalSpawnOptions) => TerminalProcess; instances: FakePty[] } {
  const instances: FakePty[] = [];
  const spawner = (options: TerminalSpawnOptions): TerminalProcess => {
    let dataListener: ((d: string) => void) | undefined;
    let exitListener: ((e: { exitCode: number; signal?: number }) => void) | undefined;
    const pty: FakePty = {
      options,
      written: [],
      resized: [],
      killed: false,
      paused: false,
      resizeThrows: false,
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
      write: (data) => pty.written.push(data),
      resize: (cols, rows) => {
        if (pty.resizeThrows) throw new Error("ioctl(2) failed, EBADF");
        pty.resized.push({ cols, rows });
      },
      pause: () => {
        pty.paused = true;
      },
      resume: () => {
        pty.paused = false;
      },
      kill: (signal) => {
        pty.killed = true;
        pty.killSignal = signal;
      },
      emitData: (data) => dataListener?.(data),
      emitExit: (exitCode) => exitListener?.({ exitCode })
    };
    instances.push(pty);
    return pty;
  };
  return { spawner, instances };
}

function registryWith(workspaces: Record<string, string>): LocalWorkspaceRegistry {
  const findById = async (id: string): Promise<LocalWorkspace | undefined> => {
    const path = workspaces[id];
    if (!path) return undefined;
    return { id, path } as LocalWorkspace;
  };
  return {
    findById,
    findByIdWithoutGitRefresh: findById
  } as unknown as LocalWorkspaceRegistry;
}

describe("TerminalSessionService", () => {
  test("spawns a login+interactive shell in the realpath-resolved workspace cwd", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), {
      spawner,
      shell: "/bin/zsh"
    });

    const received: string[] = [];
    const handle = await service.createSession({
      workspaceId: "ws-1",
      cols: 100,
      rows: 40,
      onData: (d) => received.push(d),
      onExit: () => undefined
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]!.options.cwd).toBe(dir);
    expect(instances[0]!.options.file).toBe("/bin/zsh");
    expect(instances[0]!.options.args).toEqual(["-l", "-i"]);
    expect(instances[0]!.options.cols).toBe(100);
    expect(handle.workspacePath).toBe(dir);

    instances[0]!.emitData("hello");
    expect(received).toEqual(["hello"]);

    handle.write("ls\n");
    expect(instances[0]!.written).toEqual(["ls\n"]);
  });

  test("rejects an unregistered workspace", async () => {
    const { spawner } = makeSpawner();
    const service = new TerminalSessionService(registryWith({}), { spawner });
    await expect(
      service.createSession({ workspaceId: "missing", onData: () => undefined, onExit: () => undefined })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("enforces the active-session cap", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), {
      spawner,
      maxSessions: 1
    });
    await service.createSession({ workspaceId: "ws-1", onData: () => undefined, onExit: () => undefined });
    await expect(
      service.createSession({ workspaceId: "ws-1", onData: () => undefined, onExit: () => undefined })
    ).rejects.toBeInstanceOf(TerminalSessionError);
  });

  test("swallows a resize that throws on an exited PTY instead of propagating", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), { spawner });
    const handle = await service.createSession({
      workspaceId: "ws-1",
      onData: () => undefined,
      onExit: () => undefined
    });
    // Shell's fd is closed (node-pty emits close before onExit), so resize's ioctl
    // throws while the session is still tracked. The handler must not let it escape.
    instances[0]!.resizeThrows = true;
    expect(() => handle.resize(120, 40)).not.toThrow();
  });

  test("kills the shell with SIGTERM", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), { spawner });
    const handle = await service.createSession({
      workspaceId: "ws-1",
      onData: () => undefined,
      onExit: () => undefined
    });
    handle.close();
    expect(instances[0]!.killSignal).toBe("SIGTERM");
  });

  test("scrubs AUTH_TOKEN from the shell environment", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const previous = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "secret-bearer";
    try {
      const { spawner, instances } = makeSpawner();
      const service = new TerminalSessionService(registryWith({ "ws-1": dir }), { spawner });
      await service.createSession({
        workspaceId: "ws-1",
        onData: () => undefined,
        onExit: () => undefined
      });
      expect(instances[0]!.options.env.AUTH_TOKEN).toBeUndefined();
      expect(instances[0]!.options.env.TERM).toBe("xterm-256color");
    } finally {
      if (previous === undefined) delete process.env.AUTH_TOKEN;
      else process.env.AUTH_TOKEN = previous;
    }
  });

  test("enforces the cap against concurrent (still-awaiting) creates", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), {
      spawner,
      maxSessions: 2
    });
    // Fire more creates than the cap in the same tick; the workspace lookup is async,
    // so all of them are in-flight before any is tracked. Only `maxSessions` may win.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.createSession({ workspaceId: "ws-1", onData: () => undefined, onExit: () => undefined })
      )
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    expect(instances).toHaveLength(2);
    expect(service.activeCount).toBe(2);
  });

  test("clamps resize dimensions to a sane range", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), { spawner });
    const handle = await service.createSession({
      workspaceId: "ws-1",
      onData: () => undefined,
      onExit: () => undefined
    });
    handle.resize(999999, 0);
    expect(instances[0]!.resized).toEqual([{ cols: 1000, rows: 1 }]);
  });

  test("releases the session and kills the shell on exit and on close", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agentroom-terminal-")));
    const { spawner, instances } = makeSpawner();
    const service = new TerminalSessionService(registryWith({ "ws-1": dir }), { spawner });

    let exitCode: number | undefined;
    const handle = await service.createSession({
      workspaceId: "ws-1",
      onData: () => undefined,
      onExit: (e) => {
        exitCode = e.exitCode;
      }
    });
    expect(service.activeCount).toBe(1);
    instances[0]!.emitExit(7);
    expect(exitCode).toBe(7);
    expect(service.activeCount).toBe(0);
    // Writing after exit is a no-op rather than a throw.
    expect(() => handle.write("noop")).not.toThrow();

    const handle2 = await service.createSession({
      workspaceId: "ws-1",
      onData: () => undefined,
      onExit: () => undefined
    });
    expect(service.activeCount).toBe(1);
    handle2.close();
    expect(instances[1]!.killed).toBe(true);
    expect(service.activeCount).toBe(0);
  });
});
