import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentSessionError } from "../src/agent/agentSessionTypes";
import { ChildThreadService } from "../src/children/ChildThreadService";
import { childWorktreeName, managedWorktreeBranchPattern, type ChildThreadSummary } from "../src/domain/childThreads";
import type { AgentRunnerKind, CodingAgentModelOption, LocalWorkspace, ServiceConfig } from "../src/domain/models";
import { EventBus } from "../src/events/EventBus";
import type { AgentRunner, AgentRunnerInput } from "../src/runner/AgentRunner";
import { buildServer } from "../src/server";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceGitService } from "../src/workspace/WorkspaceGitService";
import { config, createGitWorkspace, git, newAgentSessionService, waitForServiceSession, waitForSession } from "./support/agentSessionHarness";

// Every case runs against real temporary repositories and a runner that
// settles at once, so the worktree, registration and turn are all real.

function recordingRunner(runnerKind: AgentRunnerKind = "codex", models: CodingAgentModelOption[] = []) {
  const runs: AgentRunnerInput[] = [];
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind, settings: { models, defaultSettings: { model: models[0]?.id } } };
    },
    validateInputParts() {},
    async *run(input) {
      runs.push(input);
      yield { type: "run_succeeded", message: "Child finished the task" };
    },
    async cancel() {}
  };
  return { runner, runs };
}

const sonnet: CodingAgentModelOption = {
  id: "sonnet", label: "Sonnet", isDefault: true, serviceTiers: [{ id: "standard", label: "Standard" }],
  reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }]
};

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function serverWithParent(options: { workspacePath?: string; registerPath?: string; claudeModels?: CodingAgentModelOption[] } = {}) {
  const { runner, runs } = recordingRunner();
  const claude = recordingRunner("claude_code", options.claudeModels);
  const built = await buildServer({ config: await config(), runners: { codex: runner, claude_code: claude.runner } });
  closers.push(() => built.app.close());
  const workspacePath = options.workspacePath ?? (await createGitWorkspace());
  const registered = await built.app.inject({ method: "POST", url: "/api/workspaces", payload: { path: options.registerPath ?? workspacePath } });
  const workspace = registered.json().workspace as LocalWorkspace;
  const created = await built.app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, title: "Parent" } });
  return { ...built, runs, claudeRuns: claude.runs, workspace, workspacePath, parentId: created.json().session.id as string };
}

function createChild(app: Awaited<ReturnType<typeof buildServer>>["app"], parentId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/agent-sessions/${parentId}/children`, payload });
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

describe("child thread create", () => {
  it("adds a worktree, registers it, creates the child and starts its first turn with the task", async () => {
    const { app, eventBus, auditLogStore, runs, workspace, workspacePath, parentId } = await serverWithParent();
    const base = (await git(workspacePath, "rev-parse", "HEAD")).trim();

    const response = await createChild(app, parentId, { title: "Add a --json flag", task: "Add a `--json` flag to the status command." });
    expect(response.statusCode).toBe(201);
    const { session, workspace: child } = response.json() as { session: any; workspace: LocalWorkspace };

    expect(session.parent).toEqual({ sessionId: parentId, workspaceId: workspace.id });
    expect(session.title).toBe("Add a --json flag");
    expect(child.kind).toBe("managed_worktree");
    expect(child.worktree).toMatchObject({ parentWorkspaceId: workspace.id, baseCommit: base });
    const { branch, worktreePath } = child.worktree!;
    expect(branch).toMatch(managedWorktreeBranchPattern);
    expect(branch).toMatch(/^agentroom\/add-a-json-flag-[0-9a-f]{8}$/);
    expect(await realpath(worktreePath)).toBe(child.path);
    await expect(git(worktreePath, "branch", "--show-current")).resolves.toBe(`${branch}\n`);
    await expect(git(worktreePath, "rev-parse", "HEAD")).resolves.toBe(`${base}\n`);

    // The first turn opens with a system message carrying the task, rules 2 and 8.
    // That system-origin turn leaves the task's title alone.
    await expect(waitForSession(app, session.id, "idle")).resolves.toMatchObject({ title: "Add a --json flag" });
    const messages = (await app.inject({ method: "GET", url: `/api/agent-sessions/${session.id}/messages` })).json().messages;
    expect(messages[0]).toMatchObject({ role: "system", status: "sent", origin: "parent_task" });
    expect(messages[0].content).toContain("Add a `--json` flag to the status command.");
    expect(messages[0].content).toContain(branch);
    expect(messages[0].content).toContain("Uncommitted changes in the parent checkout are not here");
    expect(messages[0].content).toContain("Commit your work on this branch if your tools allow it");
    expect(runs).toHaveLength(1);
    expect(runs[0].workspacePath).toBe(child.path);
    expect(runs[0].prompt).toContain("Add a `--json` flag to the status command.");
    const started = eventBus.getRecentEvents(200).find((event) => event.type === "agent_turn_started" && (event.payload as any).sessionId === session.id);
    expect((started?.payload as any).trigger).toEqual({ kind: "parent_task", parentSessionId: parentId, tasks: [] });

    const types = eventBus.getRecentEvents(200).map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["workspace_git_operation", "workspace_registered", "agent_session_created", "agent_child_changed"]));
    const changed = eventBus.getRecentEvents(200).find((event) => event.type === "agent_child_changed")!.payload as any;
    expect(changed).toMatchObject({ parentSessionId: parentId, childSessionId: session.id, change: "created", initiation: "button" });
    expect(auditLogStore.getRecent().find((entry) => entry.type === "agent_child_changed")?.audit).toEqual({
      parentSessionId: parentId, childSessionId: session.id, change: "created", initiation: "button"
    });
  });

  it("attaches a HEAD watch to the child it registered, without the registration route", async () => {
    const { app, eventBus, parentId } = await serverWithParent();
    const { workspace: child } = (await createChild(app, parentId, { title: "Watch me", task: "Nothing yet." })).json();
    const observed = () => eventBus.getRecentEvents(500).filter((event) =>
      event.type === "workspace_branch_changed" && (event.payload as any).workspaceId === child.id && (event.payload as any).origin === "observed");

    await sleep(200);
    await git(child.worktree.worktreePath, "switch", "-c", "elsewhere");
    await until(() => observed().length > 0);
    expect(observed()[0].payload).toMatchObject({ previousBranch: child.worktree.branch, branch: "elsewhere" });
  });

  it("registers a child of a registered subdirectory at the same subdirectory of its worktree", async () => {
    const workspacePath = await createGitWorkspace();
    await mkdir(join(workspacePath, "pkg"));
    await writeFile(join(workspacePath, "pkg", "index.ts"), "export {};\n");
    await git(workspacePath, "add", ".");
    await git(workspacePath, "commit", "-m", "Add pkg");
    const { app, parentId } = await serverWithParent({ workspacePath, registerPath: join(workspacePath, "pkg") });

    const { workspace: child } = (await createChild(app, parentId, { title: "Subdir", task: "Work in pkg." })).json();
    expect(child.path.endsWith(join(child.worktree.worktreePath.split("/").at(-1), "pkg"))).toBe(true);
    expect(existsSync(join(child.path, "index.ts"))).toBe(true);
  });

  it("gives the child the parent's settings on the parent's runner", async () => {
    const { app, agentSessions, workspace } = await serverWithParent();
    const parent = (await app.inject({
      method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, settings: { model: "gpt-example" } }
    })).json().session;

    const { session } = (await createChild(app, parent.id, { title: "Settings", task: "Check settings." })).json();
    expect(agentSessions.getSession(session.id)?.settings).toEqual({ model: "gpt-example" });
    expect(session.runnerKind).toBe("codex");
  });

  it("gives the child the settings the create names over the parent's, from its first turn", async () => {
    const { app, agentSessions, runs, workspace } = await serverWithParent();
    const parent = (await app.inject({
      method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, settings: { model: "gpt-example" } }
    })).json().session;
    const settings = { model: "gpt-other", reasoningEffort: "high" };

    const { session } = (await createChild(app, parent.id, { title: "Picked", task: "Check settings.", settings })).json();
    expect(agentSessions.getSession(session.id)?.settings).toEqual(settings);
    await until(() => runs.some((run) => run.sessionId === session.id));
    expect(runs.find((run) => run.sessionId === session.id)?.settings).toEqual(settings);
  });

  it("gives a child on another runner the settings the create names", async () => {
    const { app, agentSessions, claudeRuns, parentId } = await serverWithParent({ claudeModels: [sonnet] });
    const settings = { model: "sonnet", reasoningEffort: "high" };

    const { session } = (await createChild(app, parentId, { title: "Other runner", task: "x", runnerKind: "claude_code", settings })).json();
    expect(session.runnerKind).toBe("claude_code");
    expect(agentSessions.getSession(session.id)?.settings).toEqual(settings);
    await until(() => claudeRuns.some((run) => run.sessionId === session.id));
    expect(claudeRuns.find((run) => run.sessionId === session.id)?.settings).toEqual(settings);
  });

  it("refuses settings the runner does not offer before any Git work", async () => {
    const { app, agentSessions, workspacePath, parentId } = await serverWithParent({ claudeModels: [sonnet] });
    const create = (settings: Record<string, unknown>) => createChild(app, parentId, { title: "Wrong", task: "x", runnerKind: "claude_code", settings });

    for (const settings of [{ model: "gpt-example" }, { model: "sonnet", reasoningEffort: "max" }, { reasoningEffort: "max" }, { serviceTier: "fast" }]) {
      const refused = await create(settings);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().code).toBe("unsupported_settings");
    }
    // A posture key inside `settings` refuses rather than being dropped.
    expect((await create({ model: "sonnet", permissionMode: "bypassPermissions" })).json()).toMatchObject({ code: "invalid_request" });
    expect(await git(workspacePath, "branch", "--list", "agentroom/*")).toBe("");
    expect(agentSessions.listSessions().map((session) => session.id)).toEqual([parentId]);
  });
});

describe("child thread list", () => {
  it("summarizes each open child from its worktree, with counts and no paths", async () => {
    const { app, eventBus, parentId } = await serverWithParent();
    const { session, workspace: child } = (await createChild(app, parentId, { title: "Summary", task: "Edit things." })).json();
    await waitForSession(app, session.id, "idle");
    const worktreePath = child.worktree.worktreePath;
    await writeFile(join(worktreePath, "feature.txt"), "one\ntwo\n");
    await git(worktreePath, "add", "feature.txt");
    await git(worktreePath, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "commit", "-m", "Add feature");
    await writeFile(join(worktreePath, "README.md"), "# Workspace\nedited\n");
    await writeFile(join(worktreePath, ".env"), "SECRET=1\n");

    const listed = await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` });
    expect(listed.statusCode).toBe(200);
    const { children, parentToolsAvailable } = listed.json() as { children: ChildThreadSummary[]; parentToolsAvailable: boolean };
    expect(parentToolsAvailable).toBe(false);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      sessionId: session.id,
      title: "Summary",
      runnerKind: "codex",
      status: "idle",
      workspaceId: child.id,
      branch: child.worktree.branch,
      baseCommit: child.worktree.baseCommit,
      commitsAhead: 1,
      uncommitted: true,
      untrackedCount: 1,
      missing: false,
      continuable: true,
      diff: { files: 2, insertions: 3, deletions: 0 },
      lastTurn: { status: "succeeded", lastMessage: "Child finished the task" }
    });
    expect(JSON.stringify(children[0])).not.toContain(".env");
    expect(children[0].waitingOn).toBeUndefined();

    // A permission request the person has not answered marks the child waiting.
    const turnId = children[0].lastTurn!.turnId;
    eventBus.publish("coding_permission_requested", { sessionId: session.id, turnId, requestId: "permission-1" });
    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json().children[0].waitingOn).toBe("permission");
    eventBus.publish("coding_permission_resolved", { sessionId: session.id, turnId, requestId: "permission-1" });
    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json().children[0].waitingOn).toBeUndefined();
  });

  it("reports a worktree whose folder is gone as missing", async () => {
    const { app, parentId } = await serverWithParent();
    const { workspace: child } = (await createChild(app, parentId, { title: "Gone", task: "Vanish." })).json();
    await rm(child.worktree.worktreePath, { recursive: true, force: true });

    const [summary] = (await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json().children;
    expect(summary).toMatchObject({ missing: true, commitsAhead: 0, uncommitted: false, diff: { files: 0, insertions: 0, deletions: 0 } });
  });

  it("lists nothing for a parent without children and 404s an unknown session", async () => {
    const { app, parentId } = await serverWithParent();
    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json()).toEqual({ children: [], parentToolsAvailable: false, waitingReports: 0 });
    const unknown = await app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-nope/children" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("unknown_session");
  });
});

describe("child thread queues", () => {
  it("lets a delete in another workspace run while a create waits on Git", async () => {
    const { app, parentId } = await serverWithParent();
    const original = WorkspaceGitService.prototype.addWorktree;
    let entered = () => {};
    const adding = new Promise<void>((resolve) => { entered = resolve; });
    let proceed = () => {};
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    vi.spyOn(WorkspaceGitService.prototype, "addWorktree").mockImplementationOnce(async function (this: WorkspaceGitService, worktree) {
      entered();
      await gate;
      return original.call(this, worktree);
    });
    const otherPath = await createGitWorkspace();
    const other = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: otherPath } })).json().workspace as LocalWorkspace;
    const otherSession = (await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: other.id } })).json().session.id as string;

    const creating = createChild(app, parentId, { title: "Slow", task: "Wait." });
    await adding;
    const deleted = await app.inject({ method: "DELETE", url: `/api/agent-sessions/${otherSession}` });
    expect(deleted.statusCode).toBe(204);
    proceed();
    expect((await creating).statusCode).toBe(201);
    vi.restoreAllMocks();
  });
});

describe("child thread refusals", () => {
  it("refuses a parent that is itself a child", async () => {
    const { app, parentId } = await serverWithParent();
    const { session } = (await createChild(app, parentId, { title: "Level one", task: "One." })).json();
    const nested = await createChild(app, session.id, { title: "Level two", task: "Two." });
    expect(nested.statusCode).toBe(409);
    expect(nested.json().code).toBe("parent_is_child");
  });

  it("refuses a workspace that is not a repository, and an unborn HEAD", async () => {
    const plain = await serverWithParent({ workspacePath: await mkdtemp(join(tmpdir(), "agentroom-not-git-")) });
    const notRepo = await createChild(plain.app, plain.parentId, { title: "Plain", task: "Nope." });
    expect(notRepo.statusCode).toBe(409);
    expect(notRepo.json().code).toBe("not_a_repository");

    const unbornPath = await mkdtemp(join(tmpdir(), "agentroom-unborn-"));
    await git(unbornPath, "init", "-b", "main");
    const unborn = await serverWithParent({ workspacePath: unbornPath });
    const refused = await createChild(unborn.app, unborn.parentId, { title: "Unborn", task: "Nope." });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("unborn_head");
    expect((await git(unbornPath, "worktree", "list")).trim().split("\n")).toHaveLength(1);
  });

  it("refuses an external ACP runner, an unknown runner, and invalid input", async () => {
    const { app, childThreads, parentId } = await serverWithParent();
    await expect(childThreads.create(parentId, { title: "Acp", task: "x", runnerKind: "my_acp_adapter" as AgentRunnerKind, initiation: "button" }))
      .rejects.toMatchObject({ statusCode: 409, code: "runner_unsupported" });

    const unknownRunner = await createChild(app, parentId, { title: "Bad runner", task: "x", runnerKind: "not_a_runner" });
    expect(unknownRunner.statusCode).toBe(400);
    expect((await createChild(app, parentId, { title: "x".repeat(121), task: "x" })).statusCode).toBe(400);
    expect((await createChild(app, parentId, { title: "Big", task: "x".repeat(16 * 1024 + 1) })).json()).toMatchObject({ code: "invalid_request" });
    expect((await createChild(app, parentId, { title: "Extra", task: "x", permissionMode: "bypass" })).statusCode).toBe(400);
  });

  it("refuses a turn on a closed child with child_closed", async () => {
    const { app, agentSessions, parentId } = await serverWithParent();
    const { session } = (await createChild(app, parentId, { title: "Closing", task: "x" })).json();
    await waitForSession(app, session.id, "idle");
    agentSessions.getSession(session.id)!.closedAt = new Date().toISOString();

    const turn = await app.inject({ method: "POST", url: `/api/agent-sessions/${session.id}/turns`, payload: { message: "more" } });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toEqual({ error: "This child thread is closed", code: "child_closed" });
    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${parentId}/children` })).json().children).toEqual([]);
  });

  it("caps open children at four per parent and eight in all", async () => {
    const { app, workspace, parentId } = await serverWithParent();
    for (let index = 0; index < 4; index += 1) {
      expect((await createChild(app, parentId, { title: `First ${index}`, task: "x" })).statusCode).toBe(201);
    }
    const fifth = await createChild(app, parentId, { title: "Fifth", task: "x" });
    expect(fifth.statusCode).toBe(409);
    expect(fifth.json().code).toBe("child_limit_reached");

    const parents = await Promise.all([0, 1].map(async () =>
      (await app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id } })).json().session.id as string));
    // Sent together: creates run one at a time, so the caps hold under a race.
    const results = await Promise.all([0, 1, 2, 3, 4].map((index) => createChild(app, parents[0], { title: `Second ${index}`, task: "x" })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 201, 201, 201, 409]);
    const overall = await createChild(app, parents[1], { title: "Ninth", task: "x" });
    expect(overall.statusCode).toBe(409);
    expect(overall.json().code).toBe("child_limit_reached");
    expect(overall.json().error).toContain("8 open children");
  }, 30_000);
});

describe("child thread create rollback", () => {
  async function serviceStack() {
    const serviceConfig: ServiceConfig = await config();
    const registry = new LocalWorkspaceRegistry(serviceConfig);
    const eventBus = new EventBus();
    const { runner } = recordingRunner();
    const sessions = newAgentSessionService(registry, { codex: runner }, eventBus);
    const workspacePath = await createGitWorkspace();
    const { workspace } = await registry.register({ path: workspacePath });
    const parent = await sessions.createSession({ workspaceId: workspace.id });
    const children = new ChildThreadService({
      sessions, registry, git: new WorkspaceGitService(registry), eventBus, runners: { codex: runner },
      invalidateFileIndex: () => {}, mintHex: () => "abcdef12"
    });
    closers.push(async () => children.close());
    const name = childWorktreeName("Roll back", "abcdef12");
    const worktreePath = join(registry.managedWorktreeRoot(workspace.id), name);
    const create = () => children.create(parent.id, { title: "Roll back", task: "x", initiation: "button" });
    const expectNothingLeft = async () => {
      expect(existsSync(worktreePath)).toBe(false);
      expect(await git(workspacePath, "branch", "--list", `agentroom/${name}`)).toBe("");
      expect((await registry.listWithoutGitRefresh()).map((entry) => entry.id)).toEqual([workspace.id]);
      expect(sessions.listSessions().map((session) => session.id)).toEqual([parent.id]);
      expect(eventBus.getRecentEvents(200).some((event) => event.type === "agent_child_changed")).toBe(false);
    };
    return { registry, eventBus, sessions, children, workspacePath, name, worktreePath, create, expectNothingLeft };
  }

  it("leaves nothing when the worktree add fails", async () => {
    const stack = await serviceStack();
    await git(stack.workspacePath, "branch", `agentroom/${stack.name}`);

    await expect(stack.create()).rejects.toMatchObject({ statusCode: 409, code: "worktree_add_failed" });
    expect(existsSync(stack.worktreePath)).toBe(false);
    // The branch that was in the way is the person's, and stays.
    expect(await git(stack.workspacePath, "branch", "--list", `agentroom/${stack.name}`)).not.toBe("");
    expect(stack.sessions.listSessions()).toHaveLength(1);
  });

  it("removes the worktree and branch when registration fails", async () => {
    const stack = await serviceStack();
    vi.spyOn(stack.registry, "register").mockRejectedValueOnce(new Error("registry write failed"));

    await expect(stack.create()).rejects.toThrow("registry write failed");
    await stack.expectNothingLeft();
  });

  it("unregisters the workspace when the session cannot be created", async () => {
    const stack = await serviceStack();
    vi.spyOn(stack.sessions, "createSession").mockRejectedValueOnce(new AgentSessionError("no session", 400));

    await expect(stack.create()).rejects.toThrow("no session");
    await stack.expectNothingLeft();
    const types = stack.eventBus.getRecentEvents(200).map((event) => event.type);
    expect(types.filter((type) => type === "workspace_registered" || type === "workspace_removed")).toEqual(["workspace_registered", "workspace_removed"]);
  });

  it("deletes the session when its first turn cannot start", async () => {
    const stack = await serviceStack();
    vi.spyOn(stack.sessions, "startTurn").mockRejectedValueOnce(new AgentSessionError("turn refused", 409));

    await expect(stack.create()).rejects.toThrow("turn refused");
    await stack.expectNothingLeft();
    const types = stack.eventBus.getRecentEvents(200).map((event) => event.type);
    expect(types).toContain("agent_session_deleted");
  });

  it("creates once the failure clears, with the same minted name", async () => {
    const stack = await serviceStack();
    vi.spyOn(stack.sessions, "startTurn").mockRejectedValueOnce(new AgentSessionError("turn refused", 409));
    await expect(stack.create()).rejects.toThrow();

    const { session } = await stack.create();
    await waitForServiceSession(stack.sessions, session.id, "idle");
    await expect(git(stack.worktreePath, "branch", "--show-current")).resolves.toBe(`agentroom/${stack.name}\n`);
  });
});

describe("child worktree names", () => {
  it("slugs the title and falls back to child", () => {
    expect(childWorktreeName("Add a `--json` flag!", "abc123")).toBe("add-a-json-flag-abc123");
    expect(childWorktreeName("Ünïcodé  ROUTE / fix", "abcdef")).toBe("unicode-route-fix-abcdef");
    expect(childWorktreeName("???", "abcdef")).toBe("child-abcdef");
    expect(childWorktreeName("x".repeat(80), "abcdef")).toBe(`${"x".repeat(32)}-abcdef`);
  });
});
