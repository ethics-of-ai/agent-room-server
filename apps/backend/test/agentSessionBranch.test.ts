import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../src/events/EventBus";
import { AgentRunnerInputError } from "../src/runner/AgentRunner";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import {
  config,
  createGitWorkspace,
  fileWritingRunner,
  git,
  newAgentSessionService,
  waitForServiceSession,
  writeThenHangRunner
} from "./support/agentSessionHarness";

// AgentRoom is always on the branch the Mac's checkout is on. A turn runs on
// that branch and never switches it, so a branch the agent or a person moved to
// is where the next turn of every thread in the checkout runs. A session's
// `gitBranch` only records the branch its latest turn started on.

async function sessionFixture(runnerKind: "codex" | "claude_code", write: (workspacePath: string) => Promise<void>) {
  const serviceConfig = await config();
  const workspacePath = await createGitWorkspace();
  await git(workspacePath, "branch", "feature/other");
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const registered = await registry.register({ path: workspacePath });
  const eventBus = new EventBus();
  let turnWrite = write;
  const runner = fileWritingRunner(runnerKind, (path) => turnWrite(path));
  const service = newAgentSessionService(registry, { [runnerKind]: runner }, eventBus);
  const session = await service.createSession({ workspaceId: registered.workspace.id, runnerKind });
  const runTurn = async (sessionId: string, message: string, nextWrite?: (path: string) => Promise<void>) => {
    if (nextWrite) turnWrite = nextWrite;
    await service.startTurn({ sessionId, message });
    return waitForServiceSession(service, sessionId, "idle");
  };
  return { workspacePath, registry, registered, eventBus, runner, service, session, runTurn };
}

async function switchAndCommit(workspacePath: string): Promise<void> {
  await git(workspacePath, "switch", "-c", "feature/agent");
  await writeFile(join(workspacePath, "README.md"), "# Workspace\nFrom the agent\n");
  await git(workspacePath, "commit", "-am", "Agent change");
}

const doNothing = async () => {};

const currentBranch = async (workspacePath: string) => (await git(workspacePath, "branch", "--show-current")).trim();

const announcedBranchChanges = (eventBus: EventBus) =>
  eventBus.getRecentEvents().filter((event) => event.type === "workspace_branch_changed");

describe("agent session branch", () => {
  it("runs a turn on the branch a person switched to and never switches back", async () => {
    const { workspacePath, eventBus, session, runTurn } = await sessionFixture("claude_code", doNothing);
    expect(session.gitBranch).toBe("main");
    await git(workspacePath, "switch", "feature/other");

    const settled = await runTurn(session.id, "work on the current branch");

    expect(settled.gitBranch).toBe("feature/other");
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/other");
    expect(announcedBranchChanges(eventBus)).toEqual([]);
  });

  it("leaves the agent's branch for the next turn and records where each turn started", async () => {
    const { workspacePath, session, runTurn } = await sessionFixture("claude_code", switchAndCommit);

    const first = await runTurn(session.id, "switch branches and commit");
    expect(first.gitBranch).toBe("main");
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/agent");

    const second = await runTurn(session.id, "a read-only follow-up", doNothing);
    expect(second.gitBranch).toBe("feature/agent");
    await expect(git(workspacePath, "log", "-1", "--format=%s")).resolves.toBe("Agent change\n");
  });

  it("reports the work the turn committed in its settle-time diff after switching branches", async () => {
    const { eventBus, session, runTurn } = await sessionFixture("claude_code", switchAndCommit);

    await runTurn(session.id, "switch branches and commit");

    const diffEvent = eventBus.getRecentEvents().find((event) => event.type === "coding_diff_updated");
    expect(diffEvent?.payload).toMatchObject({
      files: [{ path: "README.md", status: "modified", additions: 1, deletions: 0 }]
    });
  });

  it("accepts the next turn after the agent leaves uncommitted work on its new branch", async () => {
    const { workspacePath, session, runTurn } = await sessionFixture("claude_code", async (path) => {
      await git(path, "switch", "-c", "feature/agent");
      await writeFile(join(path, "README.md"), "# Workspace\nWork in progress\n");
    });
    await runTurn(session.id, "switch and leave work uncommitted");

    await expect(runTurn(session.id, "keep going", doNothing)).resolves.toMatchObject({ gitBranch: "feature/agent" });
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/agent");
    await expect(git(workspacePath, "status", "--porcelain")).resolves.toBe(" M README.md\n");
  });

  it("runs every thread in a checkout on the same branch", async () => {
    const { workspacePath, registered, service, session, runTurn } = await sessionFixture("claude_code", switchAndCommit);
    const other = await service.createSession({ workspaceId: registered.workspace.id, runnerKind: "claude_code" });
    expect(other.gitBranch).toBe("main");

    await runTurn(session.id, "switch branches and commit");
    const settled = await runTurn(other.id, "the other thread's turn", doNothing);

    expect(settled.gitBranch).toBe("feature/agent");
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/agent");
  });

  it("keeps the last recorded branch when a turn starts on a detached HEAD", async () => {
    const { workspacePath, session, runTurn } = await sessionFixture("claude_code", doNothing);
    await git(workspacePath, "switch", "--detach");

    const settled = await runTurn(session.id, "work detached");

    expect(settled.gitBranch).toBe("main");
    await expect(currentBranch(workspacePath)).resolves.toBe("");
  });

  it("keeps the recorded branch when a turn start is refused", async () => {
    const { workspacePath, runner, service, session } = await sessionFixture("claude_code", doNothing);
    await git(workspacePath, "switch", "feature/other");
    runner.validateInputParts = () => {
      throw new AgentRunnerInputError("Input refused");
    };

    await expect(service.startTurn({ sessionId: session.id, message: "refused" })).rejects.toThrow("Input refused");

    expect(service.getSession(session.id)?.gitBranch).toBe("main");
  });

  it("leaves the branch an agent switched to before its turn was stopped", async () => {
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

    expect(stopped.gitBranch).toBe("main");
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/stopped");
    expect(announcedBranchChanges(eventBus)).toEqual([]);
  });

  it("switches the checkout when a session is created on a named branch, and announces it", async () => {
    const { workspacePath, registered, eventBus, service } = await sessionFixture("claude_code", doNothing);

    const created = await service.createSession({
      workspaceId: registered.workspace.id,
      runnerKind: "claude_code",
      gitBranch: "feature/other"
    });

    expect(created.gitBranch).toBe("feature/other");
    await expect(currentBranch(workspacePath)).resolves.toBe("feature/other");
    expect(announcedBranchChanges(eventBus).map((event) => event.payload)).toEqual([
      { workspaceId: registered.workspace.id, path: registered.workspace.path, previousBranch: "main", branch: "feature/other" }
    ]);
  });
});
