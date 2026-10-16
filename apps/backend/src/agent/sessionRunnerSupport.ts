import type { AgentSession, AgentSessionTurn, DurableAgentSessionDocument } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import { AgentRunnerInputError, type AgentRunner, type AgentRunnerInputPart } from "../runner/AgentRunner";
import {
  LocalWorkspaceRegistryError,
  type CheckoutLocalWorkspaceBranchResult,
  type LocalWorkspaceRegistry
} from "../workspace/LocalWorkspaceRegistry";
import { AgentSessionError } from "./agentSessionTypes";

/** Check out a session's branch, announcing a change and mapping registry refusals to session errors. */
async function checkoutSessionBranch(
  deps: { registry: LocalWorkspaceRegistry; eventBus: EventBus },
  workspaceId: string,
  branch: string
): Promise<CheckoutLocalWorkspaceBranchResult> {
  try {
    const result = await deps.registry.checkoutBranch(workspaceId, branch);
    if (result.changed) {
      deps.eventBus.publish("workspace_branch_changed", {
        workspaceId: result.workspace.id,
        path: result.workspace.path,
        previousBranch: result.previousBranch,
        branch: result.branch
      });
    }
    return result;
  } catch (error) {
    if (error instanceof LocalWorkspaceRegistryError) {
      throw new AgentSessionError(error.message, error.statusCode);
    }
    throw error;
  }
}

/**
 * Re-pins a session to the branch its turn ended on. Turn start restores the
 * pinned branch so threads sharing a workspace each run on their own, but an
 * agent that switched branches itself must not be switched back: the next turn
 * would hide what it committed, or refuse to start over its uncommitted work.
 *
 * The checkout's branch is only this turn's agent's doing if nothing else could
 * have moved it. Workspaces registered inside one checkout (the repository root
 * and a subdirectory, say) share its HEAD, so the check spans all of them. A
 * turn never follows if another session's turn was running in its checkout when
 * it started, or if a later turn start or a branch change AgentRoom announced
 * touched its checkout before it settled. So a turn never follows a branch
 * another session's turn checked out or its agent left, or one a person switched
 * to through the API. A detached HEAD, or a branch with no commit yet, keeps the
 * old pin. A Git read failure leaves the pin alone and never fails the turn.
 */
export class SessionBranchFollower {
  /** Orders turn starts and announced branch changes across every workspace. */
  private clock = 0;
  private readonly touchedAt = new Map<string, number>();
  private readonly starts = new WeakMap<AgentSessionTurn, TurnStart>();
  private readonly follows = new WeakMap<AgentSessionTurn, Promise<boolean>>();

  constructor(
    private readonly deps: {
      registry: LocalWorkspaceRegistry;
      eventBus: EventBus;
      /** The service's open sessions; a deleted session's pin is not followed. */
      sessions: ReadonlyMap<string, AgentSession>;
      persist(sessionId: string): void;
    }
  ) {
    deps.eventBus.subscribe((event) => {
      if (event.type !== "workspace_branch_changed") return;
      const { workspaceId } = event.payload as { workspaceId?: unknown };
      if (typeof workspaceId === "string") this.touch(workspaceId);
    });
  }

  checkout(workspaceId: string, branch: string): Promise<CheckoutLocalWorkspaceBranchResult> {
    return checkoutSessionBranch(this.deps, workspaceId, branch);
  }

  beginTurn(workspaceId: string, turn: AgentSessionTurn): void {
    const running = [...this.deps.sessions.values()]
      .filter((other) => other.id !== turn.sessionId && other.activeTurnId !== undefined)
      .map((other) => other.workspaceId);
    this.starts.set(turn, { at: this.touch(workspaceId), running: new Set(running) });
  }

  /**
   * Turns a restart interrupted start together at startup. One alone in its
   * checkout still follows; two in the same checkout cannot say whose agent
   * left the branch, so neither does.
   */
  noteInterruptedTurns(documents: readonly DurableAgentSessionDocument[]): void {
    const interrupted = documents.flatMap(({ session, turns }) =>
      turns.filter((turn) => turn.status === "running").map((turn) => ({ workspaceId: session.workspaceId, turn })));
    for (const { turn } of interrupted) {
      const running = interrupted.filter((other) => other.turn.sessionId !== turn.sessionId).map((other) => other.workspaceId);
      this.starts.set(turn, { at: this.clock, running: new Set(running) });
    }
  }

  /**
   * Returns whether the pin moved. A turn follows once: every later call, from
   * whichever path settles the turn, waits for that first answer, so no path
   * frees the session while the follow is in flight and a terminal event that
   * lands after a stop cannot move the pin again.
   */
  follow(session: AgentSession, turn: AgentSessionTurn): Promise<boolean> {
    let following = this.follows.get(turn);
    if (!following) {
      following = this.followOnce(session, turn);
      this.follows.set(turn, following);
    }
    return following;
  }

  private async followOnce(session: AgentSession, turn: AgentSessionTurn): Promise<boolean> {
    const { workspaceId } = session;
    const start = this.starts.get(turn);
    if (!start || !this.deps.sessions.has(session.id) || this.crossed(workspaceId, start, new Map())) return false;
    try {
      const branch = await this.deps.registry.gitCurrentBranch(workspaceId);
      if (!branch || branch === session.gitBranch) return false;
      // An unborn branch cannot be checked out, so pinning it would fail the next turn.
      if (!(await this.deps.registry.gitHeadCommit(workspaceId))) return false;
      // A fresh snapshot, so the workspace read the event prompts sees the new branch.
      const workspace = await this.deps.registry.refreshWorkspaceGit(workspaceId);
      // The reads awaited; a turn start or branch change in the checkout in between wins.
      const checkoutDirs = new Map<string, string | undefined>();
      await this.readCheckoutDirs(workspaceId, start, checkoutDirs);
      if (this.crossed(workspaceId, start, checkoutDirs) !== false || !this.deps.sessions.has(session.id)) return false;
      const previousBranch = session.gitBranch;
      session.gitBranch = branch;
      this.deps.eventBus.publish("workspace_branch_changed", {
        workspaceId: workspace.id,
        path: workspace.path,
        ...(previousBranch ? { previousBranch } : {}),
        branch
      });
      this.deps.persist(session.id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether anything besides this turn may have moved its checkout: true or
   * false, or undefined while a workspace that could share it is unread. A
   * workspace whose checkout cannot be read is outside any repository, so it
   * shares none; a turn whose own checkout cannot be read never follows.
   */
  private crossed(workspaceId: string, start: TurnStart, checkoutDirs: ReadonlyMap<string, string | undefined>): boolean | undefined {
    const others = this.othersSince(start);
    if (others.has(workspaceId)) return true;
    if (others.size === 0) return false;
    if (![workspaceId, ...others].every((id) => checkoutDirs.has(id))) return undefined;
    const own = checkoutDirs.get(workspaceId);
    return own === undefined || [...others].some((id) => checkoutDirs.get(id) === own);
  }

  // Reads until every workspace that could share the checkout is known, since
  // another may be touched while a read is in flight.
  private async readCheckoutDirs(workspaceId: string, start: TurnStart, checkoutDirs: Map<string, string | undefined>): Promise<void> {
    for (;;) {
      const unread = [workspaceId, ...this.othersSince(start)].filter((id) => !checkoutDirs.has(id));
      if (unread.length === 0 || this.othersSince(start).size === 0) return;
      for (const id of unread) checkoutDirs.set(id, await this.deps.registry.gitCheckoutDir(id));
    }
  }

  /** Workspaces another session's turn was running in at this turn's start, or touched since. */
  private othersSince(start: TurnStart): Set<string> {
    const others = new Set(start.running);
    for (const [workspaceId, at] of this.touchedAt) if (at > start.at) others.add(workspaceId);
    return others;
  }

  private touch(workspaceId: string): number {
    this.clock += 1;
    this.touchedAt.set(workspaceId, this.clock);
    return this.clock;
  }
}

interface TurnStart {
  at: number;
  /** Workspaces where another session's turn was running when this one started. */
  running: ReadonlySet<string>;
}

/** The runner's own input-part check, with its refusal mapped to a session error. */
export function validateRunnerInputParts(runner: AgentRunner, inputParts: AgentRunnerInputPart[]): void {
  try {
    runner.validateInputParts(inputParts);
  } catch (error) {
    if (error instanceof AgentRunnerInputError) {
      throw new AgentSessionError(error.message, error.statusCode);
    }
    throw error;
  }
}
