import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../src/events/EventBus";
import type { AgentRunner } from "../src/runner/AgentRunner";
import { buildServer } from "../src/server";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import {
  config,
  createGitWorkspace,
  fileWritingRunner,
  git,
  newAgentSessionService,
  sessionDocument,
  waitForServiceSession,
  waitForSession,
  writeSessionDocument,
  writeThenHangRunner
} from "./support/agentSessionHarness";

// An agent that switches branches inside its turn must not be switched back by
// the next turn's session-branch restore, and the work it committed must still
// reach the turn's diff. These cases come from a live Claude Code repro where
// the second turn checked the workspace back out to `main`, hiding the agent's
// commit, and a third turn on a dirty tree was refused with a 409.

async function sessionFixture(runnerKind: "codex" | "claude_code", write: (workspacePath: string) => Promise<void>) {
  const serviceConfig = await config();
  const workspacePath = await createGitWorkspace();
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const registered = await registry.register({ path: workspacePath });
  const eventBus = new EventBus();
  let turnWrite = write;
  const runner = fileWritingRunner(runnerKind, (path) => turnWrite(path));
  const service = newAgentSessionService(registry, { [runnerKind]: runner }, eventBus);
  const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind });
  const runTurn = async (message: string, nextWrite?: (path: string) => Promise<void>) => {
    if (nextWrite) turnWrite = nextWrite;
    await service.startTurn({ sessionId: session.id, message });
    return waitForServiceSession(service, session.id, "idle");
  };
  return { workspacePath, eventBus, service, session, runTurn };
}

async function switchAndCommit(workspacePath: string): Promise<void> {
  await git(workspacePath, "switch", "-c", "feature/agent");
  await writeFile(join(workspacePath, "README.md"), "# Workspace\nFrom the agent\n");
  await git(workspacePath, "commit", "-am", "Agent change");
}

const doNothing = async () => {};

/** One checkout registered twice: at the repository root and at a subdirectory, which share HEAD. */
async function nestedWorkspaces() {
  const serviceConfig = await config();
  const workspacePath = await createGitWorkspace();
  await git(workspacePath, "branch", "feature/other");
  await mkdir(join(workspacePath, "apps"));
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const root = (await registry.register({ path: workspacePath })).workspace.id;
  const nested = (await registry.register({ path: join(workspacePath, "apps") })).workspace.id;
  return { registry, workspacePath, root, nested };
}

/** Completes each session's turn only once the test releases that session. */
function heldRunner(): { runner: AgentRunner; release(sessionId: string): void } {
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  const gate = (sessionId: string) => {
    let entry = gates.get(sessionId);
    if (!entry) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      entry = { opened, open };
      gates.set(sessionId, entry);
    }
    return entry;
  };
  return {
    release: (sessionId) => gate(sessionId).open(),
    runner: {
      ...fileWritingRunner("claude_code", doNothing),
      async *run(input) {
        await gate(input.sessionId).opened;
        yield { type: "run_succeeded", message: "done" };
      }
    }
  };
}

/** Ignores a stop until the test releases it, then switches branches and reports success late. */
function lateSuccessAfterStopRunner(): AgentRunner & { releaseLate(): void; finished: Promise<void> } {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    ...fileWritingRunner("claude_code", doNothing),
    releaseLate,
    finished,
    async *run(input) {
      await stopped;
      await late;
      await git(input.workspacePath, "switch", "-c", "feature/late");
      try {
        yield { type: "run_succeeded", message: "finished after the stop" };
      } finally {
        finish();
      }
    },
    async cancel() {
      stop();
    }
  };
}

/**
 * The first turn switches branches and runs until stopped, then ends its stream
 * the way the runner under test does; every later turn succeeds without writing.
 */
function switchThenStopOnceRunner(ending: StopEnding): AgentRunner & { switched: Promise<void>; ended: Promise<void> } {
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let markSwitched!: () => void;
  const switched = new Promise<void>((resolve) => {
    markSwitched = resolve;
  });
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  let turns = 0;
  return {
    ...fileWritingRunner("claude_code", doNothing),
    switched,
    ended,
    async *run(input) {
      turns += 1;
      if (turns > 1) {
        yield { type: "run_succeeded", message: "done" };
        return;
      }
      await git(input.workspacePath, "switch", "-c", "feature/stopped");
      markSwitched();
      await stopped;
      // Marked as the stream delivers its end, since a yield waits on the consumer.
      markEnded();
      if (ending === "run_failed") yield { type: "run_failed", error: "stopped" };
      if (ending === "throw") throw new Error("stopped");
    },
    async cancel() {
      stop();
    }
  };
}

type StopEnding = "return" | "run_failed" | "throw";

/** Switches branches, then ends the turn as a failure: a reported one, or a thrown generator. */
function failingRunner(ending: "run_failed" | "throw"): AgentRunner {
  return {
    ...fileWritingRunner("claude_code", doNothing),
    async *run(input) {
      await git(input.workspacePath, "switch", "-c", "feature/failed");
      if (ending === "throw") throw new Error("runner crashed");
      yield { type: "run_failed", error: "agent gave up" };
    }
  };
}

describe("agent session branch follow", () => {
  it("re-pins the session to the branch the agent switched to and keeps it on the next turn", async () => {
    const { workspacePath, eventBus, session, runTurn } = await sessionFixture("claude_code", switchAndCommit);
    expect(session.gitBranch).toBe("main");

    const settled = await runTurn("switch branches and commit");

    expect(settled.gitBranch).toBe("feature/agent");
    const events = eventBus.getRecentEvents();
    const branchEvent = events.find((event) => event.type === "workspace_branch_changed");
    expect(branchEvent?.payload).toMatchObject({ previousBranch: "main", branch: "feature/agent" });
    const types = events.map((event) => event.type);
    expect(types.indexOf("workspace_branch_changed")).toBeLessThan(types.indexOf("coding_turn_completed"));

    await runTurn("a read-only follow-up", doNothing);
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/agent\n");
    await expect(git(workspacePath, "log", "-1", "--format=%s")).resolves.toBe("Agent change\n");
  });

  it("reports the work the turn committed in its settle-time diff", async () => {
    const { eventBus, runTurn } = await sessionFixture("claude_code", switchAndCommit);

    await runTurn("switch branches and commit");

    const diffEvent = eventBus.getRecentEvents().find((event) => event.type === "coding_diff_updated");
    expect(diffEvent?.payload).toMatchObject({
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 0 }]
    });
  });

  it("accepts the next turn after the agent leaves uncommitted work on its new branch", async () => {
    const { workspacePath, runTurn } = await sessionFixture("claude_code", async (path) => {
      await git(path, "switch", "-c", "feature/agent");
      await writeFile(join(path, "README.md"), "# Workspace\nWork in progress\n");
    });
    await runTurn("switch and leave work uncommitted");

    // Before the fix this start was refused with a 409: restoring `main` over a dirty tree.
    await expect(runTurn("keep going", doNothing)).resolves.toMatchObject({ gitBranch: "feature/agent" });
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/agent\n");
    await expect(git(workspacePath, "status", "--porcelain")).resolves.toBe(" M README.md\n");
  });

  it("follows the branch for a runner that reports its own diff", async () => {
    const { workspacePath, eventBus, runTurn } = await sessionFixture("codex", switchAndCommit);

    const settled = await runTurn("switch branches and commit");
    await runTurn("a read-only follow-up", doNothing);

    expect(settled.gitBranch).toBe("feature/agent");
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("coding_diff_updated");
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/agent\n");
  });

  it("follows the branch an agent switched to before its turn was stopped", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const runner = writeThenHangRunner(async (path) => {
      await git(path, "switch", "-c", "feature/stopped");
    });
    const service = newAgentSessionService(registry, { claude_code: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    await service.startTurn({ sessionId: session.id, message: "start long run" });
    await runner.wrote;

    const stopped = await service.cancelTurn(session.id);

    expect(stopped.gitBranch).toBe("feature/stopped");
    const types = eventBus.getRecentEvents().map((event) => event.type);
    expect(types).toContain("workspace_branch_changed");
  });

  it.each(["return", "run_failed", "throw"] as const)("re-pins a stopped turn before the stop frees the session for its next turn (stream ends: %s)", async (ending) => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const runner = switchThenStopOnceRunner(ending);
    const service = newAgentSessionService(registry, { claude_code: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    await service.startTurn({ sessionId: session.id, message: "start long run" });
    await runner.switched;
    // A queued message goes out the moment the stop is announced.
    let next: Promise<unknown> | undefined;
    eventBus.subscribe((event) => {
      if (event.type === "agent_turn_cancelled" && !next) next = service.startTurn({ sessionId: session.id, message: "keep going" });
    });
    // Hold the follow's last Git read, so the runner's stream ends while it is in flight.
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const refresh = registry.refreshWorkspaceGit.bind(registry);
    registry.refreshWorkspaceGit = async (workspaceId) => {
      await readReleased;
      return refresh(workspaceId);
    };

    const stopping = service.cancelTurn(session.id);
    await runner.ended;
    // However the stream ended, nothing frees the session before the follow lands.
    await expect(waitForServiceSession(service, session.id, "idle")).rejects.toThrow();
    releaseRead();
    await stopping;
    await next;

    await expect(waitForServiceSession(service, session.id, "idle")).resolves.toMatchObject({ gitBranch: "feature/stopped" });
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/stopped\n");
    expect(service.getStatusSnapshot([]).metrics.cancelledTurns).toBe(1);
  });

  it.each(["run_failed", "throw"] as const)("follows the branch an agent switched to before its turn failed (%s)", async (ending) => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const service = newAgentSessionService(registry, { claude_code: failingRunner(ending) }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });

    await service.startTurn({ sessionId: session.id, message: "switch, then fail" });
    const failed = await waitForServiceSession(service, session.id, "failed");

    expect(failed.gitBranch).toBe("feature/failed");
    const types = eventBus.getRecentEvents().map((event) => event.type);
    expect(types).toContain("workspace_branch_changed");
    expect(types.indexOf("workspace_branch_changed")).toBeLessThan(types.indexOf("coding_turn_failed"));
  });

  it("follows the branch an interrupted turn left when the backend restarts", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registered = await new LocalWorkspaceRegistry(serviceConfig).register({ path: workspacePath });
    const sessionId = "agent-session-restart-branch";
    const persisted = sessionDocument(sessionId, { id: registered.workspace.id, path: workspacePath }, {
      runnerKind: "claude_code",
      running: true
    });
    (persisted.session as Record<string, unknown>).gitBranch = "main";
    await writeSessionDocument(serviceConfig, persisted);
    // The agent switched branches, then the backend stopped before the turn settled.
    await git(workspacePath, "switch", "-c", "feature/interrupted");

    const { app } = await buildServer({ config: serviceConfig, runners: { claude_code: fileWritingRunner("claude_code", doNothing) } });
    try {
      const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
      expect(detail.json().session).toMatchObject({ status: "failed", gitBranch: "feature/interrupted" });

      await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "keep going" } });
      await waitForSession(app, sessionId, "idle");
      await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("feature/interrupted\n");
    } finally {
      await app.close();
    }
  });

  it.each(["still running", "already settled"] as const)(
    "keeps a session's pin when another session's turn on the same workspace switched branches (%s)",
    async (other) => {
      const serviceConfig = await config();
      const workspacePath = await createGitWorkspace();
      await git(workspacePath, "branch", "feature/other");
      const registry = new LocalWorkspaceRegistry(serviceConfig);
      const registered = await registry.register({ path: workspacePath });
      const held = heldRunner();
      const service = newAgentSessionService(registry, { claude_code: held.runner }, new EventBus());
      const first = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
      const second = await service.createSession({
        workspaceId: registered.workspace.id,
        runnerKind: "claude_code",
        gitBranch: "feature/other"
      });

      await service.startTurn({ sessionId: first.id, message: "a long turn on main" });
      // The second turn's start checks the shared workspace out to its own pin.
      await service.startTurn({ sessionId: second.id, message: "a turn on the other branch" });
      if (other === "already settled") {
        held.release(second.id);
        await waitForServiceSession(service, second.id, "idle");
      }
      held.release(first.id);
      const settled = await waitForServiceSession(service, first.id, "idle");

      expect(settled.gitBranch).toBe("main");
      held.release(second.id);
      await expect(waitForServiceSession(service, second.id, "idle")).resolves.toMatchObject({ gitBranch: "feature/other" });
    }
  );

  it("keeps a session's pin when an earlier turn on the same workspace switches branches while it runs", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    await git(workspacePath, "branch", "feature/other");
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: workspacePath });
    const held = heldRunner();
    const service = newAgentSessionService(registry, { claude_code: held.runner }, new EventBus());
    const earlier = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    const later = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });

    await service.startTurn({ sessionId: earlier.id, message: "a turn that started first" });
    await service.startTurn({ sessionId: later.id, message: "a turn that started second" });
    // The earlier turn's agent switches branches; nothing announces it.
    await git(workspacePath, "switch", "feature/other");
    held.release(later.id);

    await expect(waitForServiceSession(service, later.id, "idle")).resolves.toMatchObject({ gitBranch: "main" });
    held.release(earlier.id);
    await waitForServiceSession(service, earlier.id, "idle");
  });

  it.each(["still running", "already settled"] as const)(
    "keeps a session's pin when a session on another workspace in the same checkout switched branches (%s)",
    async (other) => {
      const { registry, root, nested } = await nestedWorkspaces();
      const held = heldRunner();
      const service = newAgentSessionService(registry, { claude_code: held.runner }, new EventBus());
      const first = await service.createSession({ workspaceId: root, runnerKind: "claude_code" });
      const second = await service.createSession({ workspaceId: nested, runnerKind: "claude_code", gitBranch: "feature/other" });

      await service.startTurn({ sessionId: first.id, message: "a long turn on main at the repository root" });
      // The second turn's start checks the shared checkout out to its own pin.
      await service.startTurn({ sessionId: second.id, message: "a turn on the other branch in a subdirectory" });
      if (other === "already settled") {
        held.release(second.id);
        await waitForServiceSession(service, second.id, "idle");
      }
      held.release(first.id);

      await expect(waitForServiceSession(service, first.id, "idle")).resolves.toMatchObject({ gitBranch: "main" });
      held.release(second.id);
      await waitForServiceSession(service, second.id, "idle");
    }
  );

  it("keeps a session's pin when a turn on another workspace in the same checkout was running when it started", async () => {
    const { registry, workspacePath, root, nested } = await nestedWorkspaces();
    const held = heldRunner();
    const service = newAgentSessionService(registry, { claude_code: held.runner }, new EventBus());
    const earlier = await service.createSession({ workspaceId: nested, runnerKind: "claude_code" });
    const later = await service.createSession({ workspaceId: root, runnerKind: "claude_code" });

    await service.startTurn({ sessionId: earlier.id, message: "a turn in a subdirectory that started first" });
    await service.startTurn({ sessionId: later.id, message: "a turn at the repository root that started second" });
    // The earlier turn's agent switches branches; nothing announces it.
    await git(workspacePath, "switch", "feature/other");
    held.release(later.id);

    await expect(waitForServiceSession(service, later.id, "idle")).resolves.toMatchObject({ gitBranch: "main" });
    held.release(earlier.id);
    await waitForServiceSession(service, earlier.id, "idle");
  });

  it("follows the branch while another session's turn runs in a different repository", async () => {
    const serviceConfig = await config();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const busyPath = await createGitWorkspace();
    const agentPath = await createGitWorkspace();
    const busy = (await registry.register({ path: busyPath })).workspace.id;
    const switching = (await registry.register({ path: agentPath })).workspace.id;
    const held = heldRunner();
    let heldSessionId: string | undefined;
    const runner: AgentRunner = {
      ...held.runner,
      run: (input) => (input.sessionId === heldSessionId ? held.runner : fileWritingRunner("claude_code", switchAndCommit)).run(input)
    };
    const service = newAgentSessionService(registry, { claude_code: runner }, new EventBus());
    const other = await service.createSession({ workspaceId: busy, runnerKind: "claude_code" });
    heldSessionId = other.id;
    const session = await service.createSession({ workspaceId: switching, runnerKind: "claude_code" });

    await service.startTurn({ sessionId: other.id, message: "a long turn in another repository" });
    await service.startTurn({ sessionId: session.id, message: "switch branches and commit" });

    await expect(waitForServiceSession(service, session.id, "idle")).resolves.toMatchObject({ gitBranch: "feature/agent" });
    held.release(other.id);
    await waitForServiceSession(service, other.id, "idle");
  });

  it("keeps the pin when a person switches the workspace's branch during the turn", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    await git(workspacePath, "branch", "feature/person");
    const registered = await new LocalWorkspaceRegistry(serviceConfig).register({ path: workspacePath });
    const held = heldRunner();
    const { app } = await buildServer({ config: serviceConfig, runners: { claude_code: held.runner } });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/agent-sessions",
        payload: { workspaceId: registered.workspace.id, runnerKind: "claude_code" }
      });
      const sessionId = created.json().session.id as string;
      await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "a long turn" } });
      const checkout = await app.inject({
        method: "POST",
        url: `/api/workspaces/${registered.workspace.id}/git/branch`,
        payload: { branch: "feature/person" }
      });
      expect(checkout.statusCode).toBe(200);

      held.release(sessionId);
      await expect(waitForSession(app, sessionId, "idle")).resolves.toMatchObject({ gitBranch: "main" });
    } finally {
      await app.close();
    }
  });

  it("keeps both pins when two interrupted turns shared a workspace at restart", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registered = await new LocalWorkspaceRegistry(serviceConfig).register({ path: workspacePath });
    const workspace = { id: registered.workspace.id, path: workspacePath };
    for (const [sessionId, gitBranch] of [["agent-session-restart-main", "main"], ["agent-session-restart-other", "feature/other"]]) {
      const persisted = sessionDocument(sessionId!, workspace, { runnerKind: "claude_code", running: true });
      (persisted.session as Record<string, unknown>).gitBranch = gitBranch;
      await writeSessionDocument(serviceConfig, persisted);
    }
    // Either agent could have left the workspace here; nothing says which.
    await git(workspacePath, "switch", "-c", "feature/other");

    const { app } = await buildServer({ config: serviceConfig, runners: { claude_code: fileWritingRunner("claude_code", doNothing) } });
    try {
      const main = await app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-restart-main" });
      expect(main.json().session).toMatchObject({ status: "failed", gitBranch: "main" });
      const other = await app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-restart-other" });
      expect(other.json().session).toMatchObject({ status: "failed", gitBranch: "feature/other" });
    } finally {
      await app.close();
    }
  });

  it("does not follow a branch a stopped turn reports after the stop", async () => {
    const serviceConfig = await config();
    const workspacePath = await createGitWorkspace();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const registered = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const runner = lateSuccessAfterStopRunner();
    const service = newAgentSessionService(registry, { claude_code: runner }, eventBus);
    const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    await service.startTurn({ sessionId: session.id, message: "start long run" });

    await expect(service.cancelTurn(session.id)).resolves.toMatchObject({ gitBranch: "main" });
    runner.releaseLate();
    await runner.finished;

    expect(service.getSession(session.id)?.gitBranch).toBe("main");
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("workspace_branch_changed");
  });

  it("keeps the pinned branch when the turn ends on a branch with no commit yet", async () => {
    const { workspacePath, eventBus, runTurn } = await sessionFixture("claude_code", async (path) => {
      await git(path, "switch", "--orphan", "feature/orphan");
    });

    const settled = await runTurn("start an orphan branch");

    expect(settled.gitBranch).toBe("main");
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("workspace_branch_changed");
    // Before the fix this start failed: the session pinned a branch Git cannot check out.
    await runTurn("a read-only follow-up", doNothing);
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("main\n");
  });

  it("keeps the pinned branch when the turn ends on a detached HEAD", async () => {
    const { workspacePath, eventBus, runTurn } = await sessionFixture("claude_code", async (path) => {
      await git(path, "switch", "--detach");
    });

    const settled = await runTurn("detach");

    expect(settled.gitBranch).toBe("main");
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("workspace_branch_changed");
    await runTurn("a read-only follow-up", doNothing);
    await expect(git(workspacePath, "branch", "--show-current")).resolves.toBe("main\n");
  });

  it("sends no branch event when the turn stays on the session branch", async () => {
    const { eventBus, runTurn } = await sessionFixture("claude_code", doNothing);

    const settled = await runTurn("do nothing");

    expect(settled.gitBranch).toBe("main");
    expect(eventBus.getRecentEvents().map((event) => event.type)).not.toContain("workspace_branch_changed");
  });
});
