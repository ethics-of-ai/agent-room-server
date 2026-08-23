import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { spawn as ptySpawn } from "node-pty";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";

// Interactive terminal (PTY) backend. This is the one deliberate relaxation of the
// "no arbitrary shell execution" posture: it spawns a real login shell in a
// registered workspace directory, unsandboxed, running as the backend user. It is
// gated by `terminalEnabled` and bearer auth at the route; this service only owns
// the bounded cwd, the process lifecycle, and the safety caps. It never logs shell
// I/O, which can contain secrets. See docs/safety/TRUST_AND_SAFETY.md.

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// PTY dimensions are clamped so a malformed/hostile resize frame cannot ask the
// kernel for an absurd window size.
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;
const DEFAULT_MAX_SESSIONS = 8;
// Idle PTYs are reaped so a forgotten/abandoned tab does not leak a live shell.
// Reset on both keystrokes and output, so a long-running build is not killed.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class TerminalSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface TerminalSpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

// Minimal surface of node-pty's IPty that we depend on, so tests can inject a fake
// process without a real shell.
export interface TerminalProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  // Flow control for the output stream: pause() stops reading the PTY master so the
  // kernel backpressures the child, resume() restarts it. Used by the route to cap
  // an unbounded WebSocket send buffer when the client drains slowly.
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export type TerminalSpawner = (options: TerminalSpawnOptions) => TerminalProcess;

export interface CreateTerminalSessionInput {
  workspaceId: string;
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit: (event: { exitCode: number; signal?: number }) => void;
}

export interface TerminalSessionHandle {
  id: string;
  workspaceId: string;
  workspacePath: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  // Pause/resume PTY output for WebSocket backpressure. No-ops once the session
  // has been disposed.
  pause(): void;
  resume(): void;
  close(): void;
}

interface TrackedSession {
  proc: TerminalProcess;
  idleTimer?: NodeJS.Timeout;
  lastActivityAtMs: number;
}

export interface TerminalSessionServiceOptions {
  shell?: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  spawner?: TerminalSpawner;
}

export class TerminalSessionService {
  private readonly sessions = new Map<string, TrackedSession>();
  // Slots reserved by createSession calls that have passed the cap check but not yet
  // inserted their session into `sessions` (they are awaiting the workspace lookup /
  // shell spawn). Counted against the cap so concurrent upgrades cannot all slip past
  // the check while every one of them is still suspended on its await.
  private pendingSessions = 0;
  private readonly spawner: TerminalSpawner;
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly registry: LocalWorkspaceRegistry,
    private readonly options: TerminalSessionServiceOptions = {}
  ) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async createSession(input: CreateTerminalSessionInput): Promise<TerminalSessionHandle> {
    // Count in-flight reservations against the cap: the map is only populated after
    // the awaits below, so a size-only check lets N concurrent upgrades all pass while
    // each is suspended, spawning N shells instead of `maxSessions`.
    if (this.sessions.size + this.pendingSessions >= this.maxSessions) {
      throw new TerminalSessionError("Too many active terminal sessions", 429);
    }
    this.pendingSessions += 1;
    try {
      const cwd = await this.requireWorkspaceDirectory(input.workspaceId);
      const cols = clampDimension(input.cols, DEFAULT_COLS);
      const rows = clampDimension(input.rows, DEFAULT_ROWS);

      let proc: TerminalProcess;
      try {
        proc = this.spawner({
          file: resolveShell(this.options.shell),
          // Login + interactive shell so the user gets their normal prompt/profile.
          args: ["-l", "-i"],
          cwd,
          cols,
          rows,
          env: terminalEnv()
        });
      } catch (error) {
        throw new TerminalSessionError(
          `Failed to start terminal shell: ${(error as Error).message}`,
          500
        );
      }

      const id = `terminal-session-${randomUUID()}`;
      const tracked: TrackedSession = { proc, lastActivityAtMs: Date.now() };
      this.sessions.set(id, tracked);
      this.armIdleTimer(id, tracked);

      proc.onData((data) => {
        tracked.lastActivityAtMs = Date.now();
        input.onData(data);
      });
      proc.onExit((event) => {
        this.disposeSession(id);
        input.onExit(event);
      });

      return {
        id,
        workspaceId: input.workspaceId,
        workspacePath: cwd,
        write: (data: string) => {
          const session = this.sessions.get(id);
          if (!session) return;
          session.lastActivityAtMs = Date.now();
          // A write racing PTY teardown can throw on some platforms; the exit path
          // still disposes the session, so treat a post-exit write as a no-op.
          try {
            session.proc.write(data);
          } catch {
            // Shell is gone; drop the input.
          }
        },
        resize: (nextCols: number, nextRows: number) => {
          const session = this.sessions.get(id);
          if (!session) return;
          // An interactive resize is user activity; keep the session alive even when
          // the foreground process emits no output in response.
          session.lastActivityAtMs = Date.now();
          // node-pty's resize does an ioctl on the PTY fd and THROWS if the shell has
          // exited (the fd is closed) before onExit disposed the session. Without this
          // guard the throw escapes the WebSocket message handler uncaught and crashes
          // the whole backend. The exit path cleans up the session either way.
          try {
            session.proc.resize(clampDimension(nextCols, cols), clampDimension(nextRows, rows));
          } catch {
            // Shell is gone; ignore the resize.
          }
        },
        pause: () => {
          const session = this.sessions.get(id);
          if (!session) return;
          try {
            session.proc.pause();
          } catch {
            // Shell is gone; nothing to pause.
          }
        },
        resume: () => {
          const session = this.sessions.get(id);
          if (!session) return;
          try {
            session.proc.resume();
          } catch {
            // Shell is gone; nothing to resume.
          }
        },
        close: () => this.killSession(id)
      };
    } finally {
      this.pendingSessions -= 1;
    }
  }

  // Hard-terminate a session's shell and drop it from tracking. Idempotent.
  killSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      // SIGTERM per docs/safety/TRUST_AND_SAFETY.md. (node-pty's default kill signal is
      // SIGHUP; pass SIGTERM explicitly so code and the documented posture agree.)
      session.proc.kill("SIGTERM");
    } catch {
      // Process may already be gone; disposal below still cleans up tracking.
    }
    this.disposeSession(id);
  }

  // Release all sessions (server shutdown).
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.killSession(id);
    }
  }

  private disposeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(id);
  }

  // Idle reaping via a deadline check instead of clearTimeout/setTimeout per PTY
  // chunk: activity handlers only stamp `lastActivityAtMs`, and the armed timer
  // re-arms itself for the remaining window when there was activity.
  private armIdleTimer(id: string, session: TrackedSession, delayMs = this.idleTimeoutMs): void {
    session.idleTimer = setTimeout(() => {
      const idleForMs = Date.now() - session.lastActivityAtMs;
      if (idleForMs >= this.idleTimeoutMs) {
        this.killSession(id);
        return;
      }
      this.armIdleTimer(id, session, this.idleTimeoutMs - idleForMs);
    }, delayMs);
    // Do not keep the event loop alive solely for an idle terminal.
    session.idleTimer.unref?.();
  }

  private async requireWorkspaceDirectory(workspaceId: string): Promise<string> {
    const workspace = await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new TerminalSessionError("Workspace is not registered", 404);
    }
    // The terminal cwd is the registered workspace root itself — there is no
    // user-supplied subpath to bound. realpath resolves any symlinked root to a
    // concrete directory and confirms it still exists. The shell is unsandboxed
    // once running, but it always *starts* inside the registered workspace.
    const resolved = await realpath(workspace.path).catch(() => undefined);
    if (!resolved) {
      throw new TerminalSessionError("Workspace directory is unavailable", 404);
    }
    return resolved;
  }
}

function defaultSpawner(options: TerminalSpawnOptions): TerminalProcess {
  return ptySpawn(options.file, options.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as { [key: string]: string }
  });
}

function resolveShell(override?: string): string {
  const candidate = override?.trim() || process.env.SHELL?.trim() || "/bin/zsh";
  return candidate;
}

// Inherit the backend environment but advertise an xterm-capable terminal so
// colors and TUIs work. The shell otherwise runs as the operator with their own
// environment, like opening Terminal.app — with one exception: AgentRoom's own
// bearer token (`AUTH_TOKEN`, injected into the backend by the macOS supervisor) is
// scrubbed so it does not leak into the shell and every subprocess it spawns. A
// client already holds that token to reach this route, but Terminal.app would never
// carry it, and it must not propagate into build tools, telemetry, or shell history.
// Mirrors the provider-credential scrub in runner/claudeCode/settings.ts.
function terminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  delete env.AUTH_TOKEN;
  return env;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < MIN_DIMENSION) return MIN_DIMENSION;
  if (rounded > MAX_DIMENSION) return MAX_DIMENSION;
  return rounded;
}
