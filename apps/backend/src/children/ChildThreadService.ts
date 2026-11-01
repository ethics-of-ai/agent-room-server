import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentSessionService } from "../agent/AgentSessionService";
import { AgentSessionError } from "../agent/agentSessionTypes";
import {
  CHILD_THREAD_LIMITS,
  childWorktreeName,
  type ChildThreadInitiation,
  type ChildThreadSummary,
  type LocalWorkspaceWorktree
} from "../domain/childThreads";
import type { AgentRunnerKind, AgentSession, CodingAgentTurnSettings, LocalWorkspace, LocalWorkspaceGitOperationResult } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { AgentChildChangedPayload } from "../events/eventTypes";
import { publishWorkspaceGitOperation, publishWorkspaceRegistered, publishWorkspaceRemoved } from "../events/workspaceEvents";
import { logger } from "../logging/logger";
import type { AgentRunner } from "../runner/AgentRunner";
import { isRegisteredRunnerKind, runnerDescriptor } from "../runner/registry";
import { runnerDeclaresAgentToolCapability } from "../runner/shared/agentToolSets";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";
import { LocalWorkspaceRegistryError } from "../workspace/LocalWorkspaceRegistry";
import { WorkspaceGitServiceError, type WorkspaceGitService } from "../workspace/WorkspaceGitService";
import { ChildTurnTools } from "./agent/childTools";
import { ChildReports } from "./ChildReports";
import { ChildThreadError } from "./ChildThreadError";
import { checkChildSettings, childSettings } from "./childSettings";
import { buildChildThreadSummary } from "./childThreadSummary";
import { ChildWaiting } from "./childWaiting";

export interface CreateChildThreadInput {
  title: string;
  task: string;
  /** Defaults to the parent's runner, whose settings the child then takes too. */
  runnerKind?: AgentRunnerKind;
  /** Model settings for the child, in place of the parent's. */
  settings?: CodingAgentTurnSettings;
  initiation: ChildThreadInitiation;
  /** The parent agent's start-call key for this task, kept on the child for replay. */
  operationId?: string;
}

export interface CreatedChildThread {
  session: AgentSession;
  workspace: LocalWorkspace;
}

/** What Land and Update return: the Git result for the workspace they changed, and the child as it is now. */
export interface ChildThreadGitActionResult {
  /** Land changes the parent's workspace; Update changes the child's. */
  git: LocalWorkspaceGitOperationResult;
  child: ChildThreadSummary;
}

export interface ChildThreadCloseResult {
  /** True when `git branch -d` kept the branch because the parent's HEAD does not contain it. */
  branchKept: boolean;
}

export interface ChildThreadList {
  children: ChildThreadSummary[];
  /** Whether the parent's thread registered the child tools, so its agent can see these children. */
  parentToolsAvailable: boolean;
  /** Child reports held back from the parent, which ride its next person's turn. */
  waitingReports: number;
}

type ChildSessions = Pick<
  AgentSessionService,
  | "getSession" | "listSessions" | "createSession" | "startTurn" | "deleteSession" | "canContinue" | "latestTurn"
  | "listOutstandingQuestions" | "markChildClosed" | "hasWaitingAgentTurn" | "attachChildren"
  | "cancelTurn" | "listSessionMessages" | "turnTools"
>;

/**
 * Child threads: a session with a `parent`, working in a linked worktree on
 * its own branch, registered as its own workspace. This service creates,
 * lists, lands, updates and closes them, and refuses the deletes that would
 * orphan or drop an open child. Children are ordinary sessions in every other
 * respect; there is no engine between the session service and the runners.
 *
 * Create runs four steps, and a failure undoes the finished ones in reverse:
 * add the worktree, register its workspace, create the session, start its
 * first turn. The service publishes `workspace_registered` and
 * `workspace_removed` itself, as the registration route does, because the
 * HEAD watcher attaches and detaches on those events.
 *
 * Every mutation, the guarded deletes and branch changes included, runs
 * through a queue per parent workspace, so a create cannot pass the caps or a
 * refusal by racing another call on the same repository, and a call on an
 * unrelated workspace never waits on a child's Git work. A create reserves its
 * slot under the total cap until its session exists, so creates on two
 * repositories cannot both take the last slot. Land, Update and Close are
 * person actions: no agent tool reaches them.
 */
export class ChildThreadService {
  private readonly waiting: ChildWaiting;
  /** Report-back wakes; the context assembler reads its waiting reports. */
  readonly reports: ChildReports;
  /** Children whose Close, Land or Update is running its Git calls; their turns refuse until it ends. */
  private readonly busy = new Map<string, "closing" | "merging">();
  /** Sessions, parents and children, stopped on a runner with no restore path, whose conversation the stop ended. */
  private readonly stoppedWithoutRestore = new Set<string>();
  /** The tail of each parent workspace's mutation queue. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Slots under the total cap held by creates whose session does not exist yet. */
  private reservedSlots = 0;

  constructor(
    private readonly deps: {
      sessions: ChildSessions;
      registry: LocalWorkspaceRegistry;
      git: WorkspaceGitService;
      eventBus: EventBus;
      /** The configured runners; a child's runner must be one of them. */
      runners: Partial<Record<AgentRunnerKind, Pick<AgentRunner, "getCapabilities">>>;
      invalidateFileIndex(workspaceId: string): void;
      /** Test seam for the hex half of a minted name. */
      mintHex?: () => string;
    }
  ) {
    this.waiting = new ChildWaiting({
      eventBus: deps.eventBus,
      isChild: (sessionId) => Boolean(deps.sessions.getSession(sessionId)?.parent),
      outstandingQuestions: (sessionId) => deps.sessions.listOutstandingQuestions(sessionId)
    });
    this.waiting.start();
    this.reports = new ChildReports({
      sessions: deps.sessions, eventBus: deps.eventBus, summary: (child) => this.summarize(child), continuable: (session) => this.continuable(session)
    });
    this.reports.start();
    deps.sessions.attachChildren({
      observer: {
        admitTurn: (session) => {
          const busy = this.busy.get(session.id);
          if (busy === "closing") throw new AgentSessionError("This child thread is closing", 409, "child_closing");
          if (busy === "merging") throw new AgentSessionError("AgentRoom is landing or updating this child thread; try again when it finishes", 409, "child_merging");
        },
        turnEvent: (session, turn) => {
          if (turn.status === "cancelled" && stopEndsConversation(session.runnerKind)) this.stoppedWithoutRestore.add(session.id);
          this.reports.turnEvent(session, turn);
        }
      },
      // The parent agent's tools; the session service binds them per turn.
      tools: new ChildTurnTools({ service: this, sessions: deps.sessions, registry: deps.registry })
    });
  }

  close(): void {
    this.waiting.close();
    this.reports.close();
  }

  create(parentSessionId: string, input: CreateChildThreadInput): Promise<CreatedChildThread> {
    return this.exclusive(this.familyOfSession(parentSessionId), () => this.createNow(parentSessionId, input));
  }

  /** Open children only, unless `includeClosed`; closed ones keep their record and transcript (decision 8). */
  async list(parentSessionId: string, options: { includeClosed?: boolean } = {}): Promise<ChildThreadList> {
    const parent = this.requireSession(parentSessionId);
    const children = this.deps.sessions.listSessions().filter((session) =>
      session.parent?.sessionId === parent.id && (options.includeClosed || !session.closedAt));
    return {
      children: await Promise.all(children.map((child) => this.summarize(child))),
      parentToolsAvailable: this.deps.sessions.turnTools.childToolsAvailable(parent),
      waitingReports: this.reports.waitingCount(parent.id)
    };
  }

  /** One child as its parent sees it; the caller has already checked whose child it is. */
  async summarize(session: AgentSession): Promise<ChildThreadSummary> {
    const { registry } = this.deps;
    const workspace = await registry.findByIdWithoutGitRefresh(session.workspaceId);
    const parentWorkspace = workspace?.worktree ? await registry.findByIdWithoutGitRefresh(workspace.worktree.parentWorkspaceId) : undefined;
    return buildChildThreadSummary(registry.git, {
      session,
      workspace,
      latestTurn: this.deps.sessions.latestTurn(session.id),
      waitingOn: this.waiting.waitingOn(session.id),
      continuable: this.continuable(session),
      parentHead: parentWorkspace ? await registry.git.headCommit(parentWorkspace.path) : undefined
    });
  }

  /**
   * Whether a child, or a parent a report would wake, can take another turn.
   * The session service knows a restored session that lost its conversation.
   * A stop on a runner whose descriptor has no restore path also ends the
   * conversation, because its adapter kills the runtime, and only this layer
   * sees that happen.
   */
  continuable(session: AgentSession): boolean {
    if (session.closedAt || !this.deps.sessions.canContinue(session.id)) return false;
    if (!stopEndsConversation(session.runnerKind)) return true;
    return !this.stoppedWithoutRestore.has(session.id) && this.deps.sessions.latestTurn(session.id)?.status !== "cancelled";
  }

  /** How many more children this parent may open now, under both caps (rule 11). */
  freeSlots(parentSessionId: string): number {
    const { ofParent, total } = this.usedSlots(parentSessionId);
    return Math.max(0, Math.min(CHILD_THREAD_LIMITS.openPerParent - ofParent, CHILD_THREAD_LIMITS.openTotal - total));
  }

  /** Fast-forwards the parent checkout's current branch to the child's branch (decision 3). */
  land(childSessionId: string): Promise<ChildThreadGitActionResult> {
    return this.mergeChild(childSessionId, "landed", (child, parent) => this.deps.git.landChild(parent.workspaceId, child.workspaceId));
  }

  /** Merges the parent's current branch into the child's; a conflict aborts and changes nothing (decision 6). */
  update(childSessionId: string): Promise<ChildThreadGitActionResult> {
    return this.mergeChild(childSessionId, "updated", (child) => this.deps.git.updateChildFromParent(child.workspaceId));
  }

  /**
   * Land and Update. The child is marked busy while Git runs, so no turn
   * starts in a worktree mid-merge. The workspace whose tree changed, the
   * parent's for Land and the child's for Update, drops its file index.
   */
  private mergeChild(
    childSessionId: string,
    change: "landed" | "updated",
    run: (child: AgentSession, parent: NonNullable<AgentSession["parent"]>) => Promise<LocalWorkspaceGitOperationResult>
  ): Promise<ChildThreadGitActionResult> {
    return this.exclusive(this.familyOfSession(childSessionId), async () => {
      const { child, parent } = this.requireIdleOpenChild(childSessionId);
      const result = await this.whileBusy(child.id, "merging", () => this.childGit(() => run(child, parent)));
      publishWorkspaceGitOperation(this.deps.eventBus, result);
      this.deps.invalidateFileIndex(result.workspaceId);
      this.publishChange({ parentSessionId: parent.sessionId, childSessionId: child.id, change });
      return { git: result, child: await this.summarize(child) };
    });
  }

  /**
   * Closes a child without destroying work (rule 7): refuse a running child
   * and a dirty worktree, remove the worktree without `--force`, unregister
   * its workspace, then `branch -d`, which keeps an unmerged branch. Git
   * refuses to delete a branch a worktree still has checked out, so the order
   * is fixed. A folder deleted outside AgentRoom closes the same way, because
   * `worktree remove` clears Git's record of a missing path.
   *
   * Close also refuses a child with live background work, since a runner
   * starts its own turn when that work ends, and AgentRoom cannot refuse it.
   * From the idle check until Close ends, the child is marked closing, so a
   * turn sent to it meanwhile refuses with `child_closing` instead of starting
   * in a worktree being removed. A Close that fails clears the mark. A Close
   * that stopped part way, or a worktree someone removed with Git, finishes
   * the rest when Close runs again.
   */
  closeChild(childSessionId: string): Promise<ChildThreadCloseResult> {
    return this.exclusive(this.familyOfSession(childSessionId), () => {
      const { child, parent } = this.requireIdleOpenChild(childSessionId, { closing: true });
      return this.whileBusy(child.id, "closing", () => this.closeNow(child, parent));
    });
  }

  private async closeNow(child: AgentSession, parent: NonNullable<AgentSession["parent"]>): Promise<ChildThreadCloseResult> {
    const workspace = await this.deps.registry.findByIdWithoutGitRefresh(child.workspaceId);
    let branchKept = true;
    if (workspace?.worktree) {
      const { worktree } = workspace;
      if (await this.deps.registry.git.isRepository(worktree.worktreePath)) await this.deps.git.requireCleanWorktree(worktree);
      await this.removeWorktree(worktree, "worktree_remove_failed");
      await this.unregister(workspace);
      branchKept = await this.deleteBranch(worktree);
    }
    // A child whose workspace record is already gone has nothing left to
    // remove; its branch, if any, stays and is reported as kept.
    await this.deps.sessions.markChildClosed(child.id);
    this.publishChange({ parentSessionId: parent.sessionId, childSessionId: child.id, change: "closed" });
    return { branchKept };
  }

  /**
   * Runs a session delete unless it would drop an open child or orphan one
   * (decision 9, rule 9). A closed child deletes as any session does.
   */
  guardSessionDelete<T>(sessionId: string, remove: () => Promise<T>): Promise<T> {
    return this.exclusive(this.familyOfSession(sessionId), async () => {
      const session = this.deps.sessions.getSession(sessionId);
      if (session?.parent && !session.closedAt) {
        throw new ChildThreadError("This child thread is open; close it before deleting it", 409, "child_open");
      }
      if (this.openChildren().some((child) => child.parent?.sessionId === sessionId)) {
        throw new ChildThreadError("This thread has open children; close them first", 409, "has_open_children");
      }
      return remove();
    });
  }

  /** Runs a workspace unregister unless an open child works in it or branched from it (decision 9). */
  async guardWorkspaceRemoval<T>(workspaceId: string, remove: () => Promise<T>): Promise<T> {
    return this.exclusive(await this.familyOfWorkspace(workspaceId), async () => {
      const open = this.openChildren();
      if (open.some((child) => child.workspaceId === workspaceId)) {
        throw new ChildThreadError("An open child thread works in this workspace; close the child instead", 409, "child_workspace");
      }
      if (open.some((child) => child.parent?.workspaceId === workspaceId)) {
        throw new ChildThreadError("This workspace has open child threads; close them first", 409, "has_open_children");
      }
      return remove();
    });
  }

  /**
   * Runs a branch switch, or a branch create and switch, unless an open child
   * works in the workspace. Land and Update need the worktree on the child's
   * own branch, and refuse with `child_not_linked` once it moves off it.
   */
  async guardWorkspaceBranchChange<T>(workspaceId: string, change: () => Promise<T>): Promise<T> {
    return this.exclusive(await this.familyOfWorkspace(workspaceId), async () => {
      if (this.openChildren().some((child) => child.workspaceId === workspaceId)) {
        throw new ChildThreadError("An open child thread works on this worktree's branch; land or close the child instead", 409, "child_workspace");
      }
      return change();
    });
  }

  private exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  /** The queue a session's mutations take: its parent's workspace for a child, its own otherwise. */
  private familyOfSession(sessionId: string): string {
    const session = this.deps.sessions.getSession(sessionId);
    return session?.parent?.workspaceId ?? session?.workspaceId ?? `session:${sessionId}`;
  }

  /** The queue a workspace's guarded changes take: the parent's for a child worktree, its own otherwise. */
  private async familyOfWorkspace(workspaceId: string): Promise<string> {
    return (await this.deps.registry.findByIdWithoutGitRefresh(workspaceId))?.worktree?.parentWorkspaceId ?? workspaceId;
  }

  private async whileBusy<T>(childSessionId: string, mark: "closing" | "merging", run: () => Promise<T>): Promise<T> {
    this.busy.set(childSessionId, mark);
    try {
      return await run();
    } finally {
      this.busy.delete(childSessionId);
    }
  }

  private requireIdleOpenChild(
    childSessionId: string,
    options: { closing?: boolean } = {}
  ): { child: AgentSession; parent: NonNullable<AgentSession["parent"]> } {
    const child = this.requireSession(childSessionId);
    if (!child.parent) throw new ChildThreadError("This session is not a child thread", 409, "not_a_child");
    if (child.closedAt) throw new ChildThreadError("This child thread is closed", 409, "child_closed");
    if (child.activeTurnId || child.status === "running") {
      throw new ChildThreadError("The child thread has a running turn; stop it or wait for it to finish", 409, "child_running");
    }
    if (options.closing && (child.backgroundTasks?.length || this.deps.sessions.hasWaitingAgentTurn(child.id))) {
      throw new ChildThreadError("The child thread has background work running; stop it or wait for it to finish", 409, "child_running");
    }
    return { child, parent: child.parent };
  }

  // Git's refusals keep their own code; a child whose workspace record is gone is workspace_missing.
  private async childGit<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LocalWorkspaceRegistryError && error.statusCode === 404) {
        throw new ChildThreadError("A workspace this child needs is no longer registered", 404, "workspace_missing");
      }
      throw error;
    }
  }

  private async createNow(parentSessionId: string, input: CreateChildThreadInput): Promise<CreatedChildThread> {
    const parent = this.requireSession(parentSessionId);
    if (parent.parent) throw new ChildThreadError("A child thread cannot have children", 409, "parent_is_child");
    const runnerKind = input.runnerKind ?? parent.runnerKind;
    // A runner whose descriptor lacks the children capability, such as an
    // external ACP adapter, cannot run a child (rule 3).
    if (!runnerDeclaresAgentToolCapability(runnerKind, "children")) {
      throw new ChildThreadError("This runner cannot run a child thread", 409, "runner_unsupported");
    }
    const runner = this.deps.runners[runnerKind];
    if (!runner) throw new ChildThreadError(`Runner kind ${runnerKind} is not configured`, 400, "runner_unavailable");
    await checkChildSettings(input.settings, runner);
    this.requireFreeSlot(parent.id);
    this.reservedSlots += 1;
    let reserved = true;
    const release = () => {
      if (reserved) this.reservedSlots -= 1;
      reserved = false;
    };
    try {
      return await this.createInSlot(parent, input, runnerKind, release);
    } finally {
      release();
    }
  }

  /** The four create steps, holding a reserved slot until `releaseSlot` runs. */
  private async createInSlot(
    parent: AgentSession,
    input: CreateChildThreadInput,
    runnerKind: AgentRunnerKind,
    releaseSlot: () => void
  ): Promise<CreatedChildThread> {
    const { registry, sessions } = this.deps;
    const parentWorkspace = await registry.findByIdWithoutGitRefresh(parent.workspaceId);
    if (!parentWorkspace) throw new ChildThreadError("The parent's workspace is not registered", 404, "workspace_missing");
    if (parentWorkspace.kind === "managed_worktree") throw new ChildThreadError("A child thread cannot have children", 409, "parent_is_child");
    if (!(await registry.git.isRepository(parentWorkspace.path))) {
      throw new ChildThreadError("The parent's workspace is not a Git repository", 409, "not_a_repository");
    }
    const baseCommit = await registry.git.headCommit(parentWorkspace.path);
    if (!baseCommit) throw new ChildThreadError("The parent's branch has no commits to branch from", 409, "unborn_head");
    // A registered subdirectory maps to the same subdirectory in the worktree.
    const prefix = await registry.git.checkoutPrefix(parentWorkspace.path);
    const name = childWorktreeName(input.title, this.deps.mintHex?.() ?? randomBytes(4).toString("hex"));
    const worktree: LocalWorkspaceWorktree = {
      parentWorkspaceId: parentWorkspace.id,
      worktreePath: join(registry.managedWorktreeRoot(parentWorkspace.id), name),
      branch: `agentroom/${name}`,
      baseCommit
    };

    const undo: Array<{ step: string; run: () => Promise<void> }> = [];
    try {
      await this.addWorktree(worktree);
      // Remove, then delete the branch: Git refuses to delete a branch a
      // worktree still has checked out. The branch sits at the base commit,
      // which the parent's HEAD contains, so `-d` deletes it.
      undo.push({ step: "worktree", run: async () => {
        await this.removeWorktree(worktree);
        await this.deleteBranch(worktree);
      } });
      const { workspace } = await registry.register({
        path: prefix ? join(worktree.worktreePath, prefix) : worktree.worktreePath,
        name: input.title,
        worktree
      });
      publishWorkspaceRegistered(this.deps.eventBus, workspace, true);
      undo.push({ step: "workspace", run: () => this.unregister(workspace) });
      const session = await sessions.createSession({
        workspaceId: workspace.id,
        runnerKind,
        title: input.title,
        ...childSettings(input.settings, runnerKind, parent),
        parent: { sessionId: parent.id, workspaceId: parent.workspaceId, ...(input.operationId ? { operationId: input.operationId } : {}) }
      });
      undo.push({ step: "session", run: () => sessions.deleteSession(session.id) });
      // The session counts as open from here, so its reservation goes.
      releaseSlot();
      await sessions.startTurn({
        sessionId: session.id,
        origin: {
          kind: "parent_task",
          trigger: { kind: "parent_task", parentSessionId: parent.id, tasks: [] },
          message: childOpeningMessage({ title: input.title, task: input.task, branch: worktree.branch, baseCommit })
        }
      });
      this.publishChange({ parentSessionId: parent.id, childSessionId: session.id, change: "created", initiation: input.initiation });
      return { session: sessions.getSession(session.id) ?? session, workspace };
    } catch (error) {
      for (const { step, run } of undo.reverse()) {
        await run().catch((undoError: unknown) => {
          logger.warn({ err: undoError, step, branch: worktree.branch }, "Child thread rollback step failed");
        });
      }
      throw error;
    }
  }

  private openChildren(): AgentSession[] {
    return this.deps.sessions.listSessions().filter((session) => session.parent && !session.closedAt);
  }

  /** Open children of this parent, and in all with the reserved slots; a parent's creates share its queue, so it holds no reservation of its own. */
  private usedSlots(parentSessionId: string): { ofParent: number; total: number } {
    const open = this.openChildren();
    return { ofParent: open.filter((session) => session.parent?.sessionId === parentSessionId).length, total: open.length + this.reservedSlots };
  }

  private requireFreeSlot(parentSessionId: string): void {
    const { ofParent, total } = this.usedSlots(parentSessionId);
    if (ofParent >= CHILD_THREAD_LIMITS.openPerParent) {
      throw new ChildThreadError(`A thread can have ${CHILD_THREAD_LIMITS.openPerParent} open children; close one first`, 409, "child_limit_reached");
    }
    if (total >= CHILD_THREAD_LIMITS.openTotal) {
      throw new ChildThreadError(`AgentRoom allows ${CHILD_THREAD_LIMITS.openTotal} open children in all; close one first`, 409, "child_limit_reached");
    }
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) throw new ChildThreadError("Agent session was not found", 404, "unknown_session");
    return session;
  }

  private async addWorktree(worktree: LocalWorkspaceWorktree): Promise<void> {
    try {
      publishWorkspaceGitOperation(this.deps.eventBus, await this.deps.git.addWorktree(worktree));
    } catch (error) {
      // Git's own text is already credential-stripped and redacted.
      if (error instanceof WorkspaceGitServiceError) throw new ChildThreadError(error.message, 409, "worktree_add_failed");
      throw error;
    }
  }

  /** Removes the worktree; one Git no longer records is already gone. A Git refusal takes `refusal` when given. */
  private async removeWorktree(worktree: LocalWorkspaceWorktree, refusal?: "worktree_remove_failed"): Promise<void> {
    try {
      const removed = await this.deps.git.removeWorktree(worktree);
      if (removed) publishWorkspaceGitOperation(this.deps.eventBus, removed);
    } catch (error) {
      if (refusal && error instanceof WorkspaceGitServiceError) throw new ChildThreadError(error.message, 409, refusal);
      throw error;
    }
  }

  /** `branch -d`, which keeps a branch HEAD does not contain; true when it kept it. */
  private async deleteBranch(worktree: LocalWorkspaceWorktree): Promise<boolean> {
    const deleted = await this.deps.git.deleteMergedBranch(worktree);
    if (!deleted.branchKept) publishWorkspaceGitOperation(this.deps.eventBus, deleted);
    return deleted.branchKept;
  }

  private async unregister(workspace: LocalWorkspace): Promise<void> {
    await this.deps.registry.unregister(workspace.id);
    this.deps.invalidateFileIndex(workspace.id);
    publishWorkspaceRemoved(this.deps.eventBus, workspace);
  }

  private publishChange(change: Omit<AgentChildChangedPayload, "audit">): void {
    this.deps.eventBus.publish("agent_child_changed", { ...change, audit: { ...change } } satisfies AgentChildChangedPayload);
  }
}

/** A runner with no restore path loses the conversation when a turn is stopped. */
function stopEndsConversation(runnerKind: string): boolean {
  return isRegisteredRunnerKind(runnerKind) && runnerDescriptor(runnerKind).restoreStrategy === "unsupported";
}

/**
 * The system message a child's first turn opens with: the task, then what the
 * worktree holds (rule 2) and how its work gets committed (rule 8).
 */
export function childOpeningMessage(input: { title: string; task: string; branch: string; baseCommit: string }): string {
  return [
    `Task from your parent thread: ${input.title}`,
    "",
    input.task,
    "",
    `You are working in a linked Git worktree on the branch ${input.branch}, created from commit ${input.baseCommit.slice(0, 12)} ` +
      "of the parent's checkout. Uncommitted changes in the parent checkout are not here, and neither are ignored files such as " +
      ".env or node_modules.",
    "Commit your work on this branch if your tools allow it. If they do not, leave your changes in place and say so; " +
      "a person will review and commit them."
  ].join("\n");
}
