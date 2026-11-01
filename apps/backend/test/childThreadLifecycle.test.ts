import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildThreadSummary } from "../src/domain/childThreads";
import type { LocalWorkspace } from "../src/domain/models";
import type { AgentRunner } from "../src/runner/AgentRunner";
import { buildServer } from "../src/server";
import { AgentTurnContextAssembler } from "../src/agent/AgentTurnContextAssembler";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";
import { WorkspaceGitService, WorkspaceGitServiceError } from "../src/workspace/WorkspaceGitService";
import { config, createGitWorkspace, git, waitForSession, waitForSessionWhere } from "./support/agentSessionHarness";

// Land, Update from parent, Close and the delete refusals, against real
// temporary repositories. The runner settles at once unless a test holds it,
// which is how a child gets a running turn.

const slow = 30_000;

function holdableRunner() {
  let gate: Promise<void> | undefined;
  let open = () => {};
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      if (gate) await gate;
      yield { type: "run_succeeded", message: "Done" };
    },
    async cancel() {
      open();
    }
  };
  return {
    runner,
    hold: () => { gate = new Promise<void>((resolve) => { open = resolve; }); },
    release: () => { gate = undefined; open(); }
  };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

type App = Awaited<ReturnType<typeof buildServer>>["app"];

async function serverWithChild(title = "Child task") {
  const held = holdableRunner();
  const serviceConfig = await config();
  const built = await buildServer({ config: serviceConfig, runners: { codex: held.runner } });
  closers.push(() => built.app.close());
  const workspacePath = await createGitWorkspace();
  const parentWorkspace = (await built.app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspacePath } })).json()
    .workspace as LocalWorkspace;
  const parentId = (await built.app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: parentWorkspace.id, title: "Parent" } }))
    .json().session.id as string;
  const created = await built.app.inject({ method: "POST", url: `/api/agent-sessions/${parentId}/children`, payload: { title, task: "Do it." } });
  expect(created.statusCode).toBe(201);
  const { session, workspace: childWorkspace } = created.json() as { session: { id: string }; workspace: LocalWorkspace };
  await waitForSession(built.app, session.id, "idle");
  // The child's settled first turn wakes the parent, and that wake reads the
  // worktree's Git state. Let it finish so a test's own Git writes find no lock.
  await waitForSessionWhere(built.app, parentId, (parent) => parent.status === "idle" && parent.turnCount === 1, "the parent's report wake");
  const worktree = childWorkspace.worktree!;
  return { ...built, ...held, serviceConfig, workspacePath, parentWorkspace, parentId, childId: session.id, childWorkspace, worktree };
}

const post = (app: App, url: string) => app.inject({ method: "POST", url });
const land = (app: App, id: string) => post(app, `/api/agent-sessions/${id}/land`);
const update = (app: App, id: string) => post(app, `/api/agent-sessions/${id}/update-from-parent`);
const close = (app: App, id: string) => post(app, `/api/agent-sessions/${id}/close`);

async function commitFile(cwd: string, file: string, content: string, message = `Edit ${file}`): Promise<string> {
  await writeFile(join(cwd, file), content);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-m", message);
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

/** Starts a child turn the runner holds open, so the child is running. */
async function runningChild(stack: Awaited<ReturnType<typeof serverWithChild>>): Promise<void> {
  stack.hold();
  const turn = await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "more" } });
  expect(turn.statusCode).toBe(202);
}

function changes(stack: Awaited<ReturnType<typeof serverWithChild>>, change: string) {
  return stack.eventBus.getRecentEvents(500)
    .filter((event) => event.type === "agent_child_changed" && (event.payload as any).change === change)
    .map((event) => event.payload as any);
}

function gitOperations(stack: Awaited<ReturnType<typeof serverWithChild>>) {
  return stack.eventBus.getRecentEvents(500)
    .filter((event) => event.type === "workspace_git_operation")
    .map((event) => event.payload as any);
}

describe("child thread Land", () => {
  it("fast-forwards the parent to the child's commits and announces it", async () => {
    const invalidate = vi.spyOn(WorkspaceExplorer.prototype, "invalidateFileIndex");
    const stack = await serverWithChild();
    const head = await commitFile(stack.worktree.worktreePath, "feature.txt", "feature\n");

    const response = await land(stack.app, stack.childId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { git: any; child: ChildThreadSummary };
    expect(body.git).toMatchObject({ operation: "merge_ff", workspaceId: stack.parentWorkspace.id, branch: stack.worktree.branch, commit: head });
    // The parent now has the child's commit, so nothing is left to land.
    expect(body.child).toMatchObject({ sessionId: stack.childId, commitsAhead: 0, uncommitted: false });
    expect((await git(stack.workspacePath, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(existsSync(join(stack.workspacePath, "feature.txt"))).toBe(true);
    expect(gitOperations(stack).at(-1)).toMatchObject({ workspaceId: stack.parentWorkspace.id, operation: "merge_ff", commit: head });
    expect(changes(stack, "landed")).toEqual([
      { parentSessionId: stack.parentId, childSessionId: stack.childId, change: "landed", audit: { parentSessionId: stack.parentId, childSessionId: stack.childId, change: "landed" } }
    ]);
    expect(invalidate).toHaveBeenCalledWith(stack.parentWorkspace.id);
  }, slow);

  it("refuses a running child and a dirty one", async () => {
    const stack = await serverWithChild();
    await writeFile(join(stack.worktree.worktreePath, "draft.txt"), "draft\n");
    const dirty = await land(stack.app, stack.childId);
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().code).toBe("child_dirty");

    await runningChild(stack);
    const running = await land(stack.app, stack.childId);
    expect(running.statusCode).toBe(409);
    expect(running.json().code).toBe("child_running");
    stack.release();
    await waitForSession(stack.app, stack.childId, "idle");
  }, slow);

  it("refuses when the parent branch moved, and when parent changes are in the way", async () => {
    const stack = await serverWithChild();
    await commitFile(stack.worktree.worktreePath, "README.md", "# Workspace\nchild\n");

    await writeFile(join(stack.workspacePath, "README.md"), "# Workspace\nparent draft\n");
    const inTheWay = await land(stack.app, stack.childId);
    expect(inTheWay.statusCode).toBe(409);
    expect(inTheWay.json().code).toBe("parent_changes_in_the_way");
    await git(stack.workspacePath, "checkout", "--", "README.md");

    const parentHead = await commitFile(stack.workspacePath, "other.txt", "parent\n");
    const moved = await land(stack.app, stack.childId);
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ code: "not_fast_forward" });
    expect((await git(stack.workspacePath, "rev-parse", "HEAD")).trim()).toBe(parentHead);
    expect(changes(stack, "landed")).toEqual([]);
  }, slow);

  it("refuses a session that is not an open child, and a child whose worktree is gone", async () => {
    const stack = await serverWithChild();
    expect((await land(stack.app, "missing")).json()).toMatchObject({ code: "unknown_session" });
    const notChild = await land(stack.app, stack.parentId);
    expect(notChild.statusCode).toBe(409);
    expect(notChild.json().code).toBe("not_a_child");

    await rm(stack.worktree.worktreePath, { recursive: true, force: true });
    const unlinked = await land(stack.app, stack.childId);
    expect(unlinked.statusCode).toBe(409);
    expect(unlinked.json().code).toBe("child_not_linked");
  }, slow);
});

describe("turns during Land and Update", () => {
  it("refuses a turn on the child while Land runs its Git calls", async () => {
    const stack = await serverWithChild();
    await commitFile(stack.worktree.worktreePath, "feature.txt", "feature\n");
    const original = WorkspaceGitService.prototype.landChild;
    let entered = () => {};
    const landing = new Promise<void>((resolve) => { entered = resolve; });
    let proceed = () => {};
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    vi.spyOn(WorkspaceGitService.prototype, "landChild").mockImplementationOnce(async function (this: WorkspaceGitService, parentId, childId) {
      entered();
      await gate;
      return original.call(this, parentId, childId);
    });

    const landed = land(stack.app, stack.childId);
    await landing;
    const refused = await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "more" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("child_merging");
    proceed();
    expect((await landed).statusCode).toBe(200);
    const accepted = await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "more" } });
    expect(accepted.statusCode).toBe(202);
    await waitForSession(stack.app, stack.childId, "idle");
  }, slow);
});

describe("child thread Update from parent", () => {
  it("merges the parent's branch into the child's, after which Land fast-forwards", async () => {
    const invalidate = vi.spyOn(WorkspaceExplorer.prototype, "invalidateFileIndex");
    const stack = await serverWithChild();
    await commitFile(stack.worktree.worktreePath, "feature.txt", "feature\n");
    await commitFile(stack.workspacePath, "other.txt", "parent\n");
    expect((await land(stack.app, stack.childId)).json().code).toBe("not_fast_forward");

    const response = await update(stack.app, stack.childId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { git: any; child: ChildThreadSummary };
    expect(body.git).toMatchObject({ operation: "update_from_parent", workspaceId: stack.childWorkspace.id, branch: stack.worktree.branch });
    expect(existsSync(join(stack.worktree.worktreePath, "other.txt"))).toBe(true);
    expect(changes(stack, "updated")).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith(stack.childWorkspace.id);

    expect((await land(stack.app, stack.childId)).statusCode).toBe(200);
    expect((await git(stack.workspacePath, "rev-parse", "HEAD")).trim()).toBe(body.git.commit);
  }, slow);

  it("aborts a conflicted merge and leaves the child's branch and tree as they were", async () => {
    const stack = await serverWithChild();
    const childHead = await commitFile(stack.worktree.worktreePath, "README.md", "# Workspace\nchild\n");
    await commitFile(stack.workspacePath, "README.md", "# Workspace\nparent\n");

    const response = await update(stack.app, stack.childId);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("update_conflicted");
    expect((await git(stack.worktree.worktreePath, "rev-parse", "HEAD")).trim()).toBe(childHead);
    expect(await git(stack.worktree.worktreePath, "status", "--porcelain")).toBe("");
    expect(changes(stack, "updated")).toEqual([]);
  }, slow);

  it("refuses a running child, a dirty child and a detached parent", async () => {
    const stack = await serverWithChild();
    await writeFile(join(stack.worktree.worktreePath, "draft.txt"), "draft\n");
    expect((await update(stack.app, stack.childId)).json().code).toBe("child_dirty");
    await rm(join(stack.worktree.worktreePath, "draft.txt"));

    await git(stack.workspacePath, "checkout", "--detach");
    const detached = await update(stack.app, stack.childId);
    expect(detached.statusCode).toBe(409);
    expect(detached.json().code).toBe("parent_detached");
    await git(stack.workspacePath, "checkout", "main");

    await runningChild(stack);
    expect((await update(stack.app, stack.childId)).json().code).toBe("child_running");
    stack.release();
    await waitForSession(stack.app, stack.childId, "idle");
  }, slow);
});

describe("child thread Close", () => {
  it("removes the worktree, unregisters its workspace, deletes a merged branch and keeps the record", async () => {
    const stack = await serverWithChild();
    const response = await close(stack.app, stack.childId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branchKept: false });

    expect(existsSync(stack.worktree.worktreePath)).toBe(false);
    expect(await git(stack.workspacePath, "branch", "--list", stack.worktree.branch)).toBe("");
    const { workspaces } = (await stack.app.inject({ method: "GET", url: "/api/workspaces" })).json() as { workspaces: LocalWorkspace[] };
    expect(workspaces.map((workspace) => workspace.id)).not.toContain(stack.childWorkspace.id);
    const session = (await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.childId}` })).json().session;
    expect(session.closedAt).toEqual(expect.any(String));
    const messages = (await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.childId}/messages` })).json().messages;
    expect(messages.length).toBeGreaterThan(0);

    const types = stack.eventBus.getRecentEvents(500).map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["workspace_removed"]));
    expect(gitOperations(stack).map((operation) => operation.operation)).toEqual(expect.arrayContaining(["worktree_remove", "branch_delete"]));
    expect(changes(stack, "closed")).toMatchObject([{ parentSessionId: stack.parentId, childSessionId: stack.childId, change: "closed" }]);

    // The durable record carries closedAt, so a restarted backend still sees the child as closed.
    await stack.durableSessions.flush();
    const restarted = await buildServer({ config: stack.serviceConfig, runners: { codex: holdableRunner().runner } });
    closers.push(() => restarted.app.close());
    expect(restarted.agentSessions.getSession(stack.childId)?.closedAt).toBe(session.closedAt);

    const turn = await stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "again" } });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toEqual({ error: "This child thread is closed", code: "child_closed" });
    expect((await close(stack.app, stack.childId)).json().code).toBe("child_closed");
    expect((await land(stack.app, stack.childId)).json().code).toBe("child_closed");
  }, slow);

  it("keeps a branch with unlanded commits and reports it", async () => {
    const stack = await serverWithChild();
    const head = await commitFile(stack.worktree.worktreePath, "feature.txt", "feature\n");

    const response = await close(stack.app, stack.childId);
    expect(response.json()).toEqual({ branchKept: true });
    expect(existsSync(stack.worktree.worktreePath)).toBe(false);
    expect((await git(stack.workspacePath, "rev-parse", stack.worktree.branch)).trim()).toBe(head);
    expect(gitOperations(stack).map((operation) => operation.operation)).not.toContain("branch_delete");
  }, slow);

  it("deletes a landed branch", async () => {
    const stack = await serverWithChild();
    await commitFile(stack.worktree.worktreePath, "feature.txt", "feature\n");
    expect((await land(stack.app, stack.childId)).statusCode).toBe(200);
    expect((await close(stack.app, stack.childId)).json()).toEqual({ branchKept: false });
  }, slow);

  it("closes a child whose folder was deleted outside AgentRoom", async () => {
    const stack = await serverWithChild();
    await rm(stack.worktree.worktreePath, { recursive: true, force: true });

    const response = await close(stack.app, stack.childId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branchKept: false });
    expect(await git(stack.workspacePath, "worktree", "list")).not.toContain(stack.worktree.worktreePath);
  }, slow);

  it("finishes a Close once Git no longer records the worktree", async () => {
    const stack = await serverWithChild();
    // Someone removed it with Git, or an earlier Close stopped after its remove.
    await git(stack.workspacePath, "worktree", "remove", "--", stack.worktree.worktreePath);

    const response = await close(stack.app, stack.childId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branchKept: false });
    const workspaces = (await stack.app.inject({ method: "GET", url: "/api/workspaces" })).json().workspaces as LocalWorkspace[];
    expect(workspaces.map((workspace) => workspace.id)).not.toContain(stack.childWorkspace.id);
    expect(changes(stack, "closed")).toHaveLength(1);
  }, slow);

  it("refuses a child whose runner still runs background work", async () => {
    const stack = await serverWithChild();
    stack.agentSessions.getSession(stack.childId)!.backgroundTasks = [
      { id: "task-1", kind: "shell", description: "npm run dev", startedAt: new Date().toISOString() }
    ];

    const refused = await close(stack.app, stack.childId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("child_running");
    expect(existsSync(stack.worktree.worktreePath)).toBe(true);
  }, slow);

  it("refuses a turn whose start overlapped a Close that finished", async () => {
    const stack = await serverWithChild();
    const original = AgentTurnContextAssembler.prototype.assemble;
    let assembled = () => {};
    const reached = new Promise<void>((resolve) => { assembled = resolve; });
    let proceed = () => {};
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    vi.spyOn(AgentTurnContextAssembler.prototype, "assemble").mockImplementationOnce(async function (this: AgentTurnContextAssembler, input) {
      const result = await original.call(this, input);
      assembled();
      await gate;
      return result;
    });

    const turn = stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "more" } });
    await reached;
    expect((await close(stack.app, stack.childId)).statusCode).toBe(200);
    proceed();
    const refused = await turn;
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("child_closed");
    expect(stack.agentSessions.getSession(stack.childId)?.activeTurnId).toBeUndefined();
  }, slow);

  it("refuses a running child and a dirty worktree, and changes nothing", async () => {
    const stack = await serverWithChild();
    await writeFile(join(stack.worktree.worktreePath, "draft.txt"), "draft\n");
    const dirty = await close(stack.app, stack.childId);
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().code).toBe("child_dirty");
    expect(existsSync(join(stack.worktree.worktreePath, "draft.txt"))).toBe(true);
    await rm(join(stack.worktree.worktreePath, "draft.txt"));

    await runningChild(stack);
    expect((await close(stack.app, stack.childId)).json().code).toBe("child_running");
    stack.release();
    await waitForSession(stack.app, stack.childId, "idle");
    expect(existsSync(stack.worktree.worktreePath)).toBe(true);
    expect(changes(stack, "closed")).toEqual([]);
  }, slow);

  it("refuses a turn sent while Close runs its Git calls, and takes turns again after a Close that failed", async () => {
    const stack = await serverWithChild();
    const turn = () => stack.app.inject({ method: "POST", url: `/api/agent-sessions/${stack.childId}/turns`, payload: { message: "more" } });
    const original = WorkspaceGitService.prototype.removeWorktree;
    let entered = () => {};
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    let proceed = () => {};
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const remove = vi.spyOn(WorkspaceGitService.prototype, "removeWorktree").mockImplementationOnce(async function (this: WorkspaceGitService, worktree) {
      entered();
      await gate;
      return original.call(this, worktree);
    });

    const closing = close(stack.app, stack.childId);
    await removing;
    const refused = await turn();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "This child thread is closing", code: "child_closing" });
    proceed();
    expect((await closing).statusCode).toBe(200);
    expect((await turn()).json().code).toBe("child_closed");

    const second = await serverWithChild("Second child");
    remove.mockRejectedValueOnce(new WorkspaceGitServiceError("Git worktree remove failed", 409));
    expect((await close(second.app, second.childId)).json().code).toBe("worktree_remove_failed");
    const accepted = await second.app.inject({ method: "POST", url: `/api/agent-sessions/${second.childId}/turns`, payload: { message: "more" } });
    expect(accepted.statusCode).toBe(202);
    await waitForSession(second.app, second.childId, "idle");
  }, slow);

  it("lists a closed child only with include=closed", async () => {
    const stack = await serverWithChild();
    expect((await close(stack.app, stack.childId)).statusCode).toBe(200);
    const list = (query = "") => stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.parentId}/children${query}` });

    expect((await list()).json().children).toEqual([]);
    const { children } = (await list("?include=closed")).json() as { children: ChildThreadSummary[] };
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ sessionId: stack.childId, closedAt: expect.any(String), missing: true, continuable: false });
    expect((await list("?include=everything")).statusCode).toBe(400);
  }, slow);
});

describe("deletes that would remove an open child", () => {
  it("refuses deleting an open child, its parent, its workspace and the parent's workspace", async () => {
    const stack = await serverWithChild();
    const remove = (url: string) => stack.app.inject({ method: "DELETE", url });

    const child = await remove(`/api/agent-sessions/${stack.childId}`);
    expect(child.statusCode).toBe(409);
    expect(child.json()).toEqual({ error: "This child thread is open; close it before deleting it", code: "child_open" });
    const parent = await remove(`/api/agent-sessions/${stack.parentId}`);
    expect(parent.statusCode).toBe(409);
    expect(parent.json().code).toBe("has_open_children");
    const childWorkspace = await remove(`/api/workspaces/${stack.childWorkspace.id}`);
    expect(childWorkspace.statusCode).toBe(409);
    expect(childWorkspace.json().code).toBe("child_workspace");
    const parentWorkspace = await remove(`/api/workspaces/${stack.parentWorkspace.id}`);
    expect(parentWorkspace.statusCode).toBe(409);
    expect(parentWorkspace.json().code).toBe("has_open_children");
    expect(existsSync(stack.worktree.worktreePath)).toBe(true);
  }, slow);

  it("deletes a closed child, then its parent, then the parent's workspace", async () => {
    const stack = await serverWithChild();
    expect((await close(stack.app, stack.childId)).statusCode).toBe(200);
    const remove = (url: string) => stack.app.inject({ method: "DELETE", url });

    expect((await remove(`/api/agent-sessions/${stack.childId}`)).statusCode).toBe(204);
    expect((await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.childId}` })).statusCode).toBe(404);
    expect((await remove(`/api/agent-sessions/${stack.parentId}`)).statusCode).toBe(204);
    expect((await remove(`/api/workspaces/${stack.parentWorkspace.id}`)).statusCode).toBe(204);
  }, slow);

  it("keeps the existing refusal shape for an unknown session", async () => {
    const stack = await serverWithChild();
    const response = await stack.app.inject({ method: "DELETE", url: "/api/agent-sessions/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Agent session was not found" });
  }, slow);
});

describe("branch changes on a child worktree", () => {
  it("refuses switching an open child's worktree to another branch, or creating one there", async () => {
    const stack = await serverWithChild();
    await git(stack.workspacePath, "branch", "side");
    const branchRoute = `/api/workspaces/${stack.childWorkspace.id}/git/branch`;

    const switched = await stack.app.inject({ method: "POST", url: branchRoute, payload: { branch: "side" } });
    expect(switched.statusCode).toBe(409);
    expect(switched.json()).toEqual({
      error: "An open child thread works on this worktree's branch; land or close the child instead",
      code: "child_workspace"
    });
    const created = await stack.app.inject({ method: "POST", url: `${branchRoute}/create`, payload: { branch: "fresh" } });
    expect(created.statusCode).toBe(409);
    expect(created.json().code).toBe("child_workspace");

    expect((await git(stack.worktree.worktreePath, "branch", "--show-current")).trim()).toBe(stack.worktree.branch);
    expect(await git(stack.workspacePath, "branch", "--list", "fresh")).toBe("");
    expect((await land(stack.app, stack.childId)).statusCode).toBe(200);
  }, slow);

  it("still switches the parent's branch", async () => {
    const stack = await serverWithChild();
    await git(stack.workspacePath, "branch", "side");
    const parentSwitch = await stack.app.inject({
      method: "POST",
      url: `/api/workspaces/${stack.parentWorkspace.id}/git/branch`,
      payload: { branch: "side" }
    });
    expect(parentSwitch.statusCode).toBe(200);
    expect(parentSwitch.json().branch).toBe("side");
  }, slow);
});
