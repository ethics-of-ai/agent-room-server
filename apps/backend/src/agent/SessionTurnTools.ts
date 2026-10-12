import { prepareAgentRunnerToolSet, type PreparedAgentRunnerToolSet } from "../agentTools/runnerToolSet";
import type { AgentSession, AgentSessionTurn, AgentTurnContext, ServiceConfig } from "../domain/models";
import type { AgentRunnerActivity } from "../runner/AgentRunner";
import { SessionQuestionChannel } from "./SessionQuestionChannel";
import type { PlanTurnOutcome } from "../plans/ThreadPlanService";
import type { ThreadPlanTurnTools } from "../plans/planTurnTools";
import type { AgentRunnerToolSet } from "../runner/AgentRunner";
import { SketchTurnTools, type SessionSketches } from "../sketch/agent/SketchTurnTools";

/**
 * The one place a session's tool families become a turn's tool set. Plan and
 * sketch handlers join one `prepareAgentRunnerToolSet` binding, so a runner
 * sees one catalog and one dispatcher, and the binding dies the moment the
 * turn settles. This is a composer, not a plugin seam: a new family is a new
 * field here.
 *
 * It also records the catalog on the session. A native thread keeps the
 * catalog it started with (Codex records it at `thread/start`; a live Claude
 * Code or DeepSeek child keeps what it registered), so the turn that starts a
 * session's thread stores its tool logical ids as `threadAgentToolIds`, and
 * `sketchToolsAvailable` says whether those ids hold every sketch tool. A
 * session from before the fields existed reports false. A session whose
 * runner offers no sketch tools now has no field, since a new thread would
 * not have them either.
 */
export type { SessionSketches } from "../sketch/agent/SketchTurnTools";

export class SessionTurnTools {
  private readonly bindings = new Map<string, { prepared: PreparedAgentRunnerToolSet; sessionId: string }>();
  readonly sketches: SketchTurnTools;
  /** Questions asked by backend-owned tools; the session service answers here before the runner. */
  readonly questions: SessionQuestionChannel;

  constructor(private readonly plans: ThreadPlanTurnTools, deps: {
    sketches?: SessionSketches;
    runnerConfig?: ServiceConfig;
    sessions: ReadonlyMap<string, AgentSession>;
    turns: ReadonlyMap<string, AgentSessionTurn>;
    /** Publish an activity on a turn, through the same path a runner's events take. */
    activity(session: AgentSession, turn: AgentSessionTurn, activity: AgentRunnerActivity): void;
  }) {
    this.sketches = new SketchTurnTools({ ...deps, sessionOfTurn: (turnId) => deps.turns.get(turnId)?.sessionId });
    this.questions = new SessionQuestionChannel({
      enabled: () => deps.runnerConfig?.clarifyingQuestionsEnabled !== false,
      publish: (sessionId, turnId, activity) => {
        const session = deps.sessions.get(sessionId);
        const turn = deps.turns.get(turnId);
        if (session && turn) deps.activity(session, turn, activity);
      }
    });
  }

  /**
   * Seed `sketchToolsAvailable` on a new or hydrated session that does not
   * have it yet: what the runner offers now for a session with no thread,
   * otherwise what the thread recorded. Clear it when the runner offers no
   * sketch tools now.
   */
  describe(session: AgentSession): void {
    if (this.sketches.advertised(session.runnerKind).length === 0) {
      delete session.sketchToolsAvailable;
      return;
    }
    if (session.sketchToolsAvailable !== undefined) return;
    session.sketchToolsAvailable = this.sketches.covers(session.runner?.nativeSessionId === undefined
      ? this.sketches.advertised(session.runnerKind) : session.threadAgentToolIds ?? []);
  }

  /** A fresh binding for one turn, or undefined when the runner advertises no tools. */
  bind(input: {
    session: AgentSession;
    turnId: string;
    context: AgentTurnContext | undefined;
    isLive(): boolean;
  }): AgentRunnerToolSet | undefined {
    const { session } = input;
    const planIds = this.plans.advertised(session.runnerKind);
    const sketchIds = this.sketches.advertised(session.runnerKind);
    const allowed = [...planIds, ...sketchIds];
    if (session.runner?.nativeSessionId === undefined) {
      // This turn starts the thread, so its catalog is the one the thread keeps.
      session.threadAgentToolIds = allowed;
      if (sketchIds.length === 0) delete session.sketchToolsAvailable;
      else session.sketchToolsAvailable = this.sketches.covers(allowed);
    }
    if (allowed.length === 0) return undefined;
    const prepared = prepareAgentRunnerToolSet({
      runId: input.turnId,
      sessionKey: session.id,
      catalog: allowed,
      allowed,
      required: input.context?.planToolsRequired === true && planIds.length > 0,
      handlers: {
        ...(planIds.length > 0 ? this.plans.handlers(session.id) : {}),
        ...(sketchIds.length > 0 ? this.sketches.handlers(session, input.turnId, (sets, signal) =>
          this.questions.ask({ sessionId: session.id, turnId: input.turnId, sets, isLive: input.isLive, ...(signal ? { signal } : {}) })) : {})
      },
      isLive: input.isLive
    });
    this.bindings.set(input.turnId, { prepared, sessionId: session.id });
    const instructions = [planIds.length > 0 ? this.plans.instruction : undefined, sketchIds.length > 0 ? this.sketches.instruction : undefined]
      .filter((text): text is string => text !== undefined);
    return { ...prepared.tools, instructions: instructions.join("\n\n") };
  }

  /**
   * End a turn's binding and release its open questions as cancelled. Later
   * calls, and results that settle after this, are refused.
   */
  release(turnId: string): void {
    const binding = this.bindings.get(turnId);
    if (!binding) return;
    binding.prepared.dispose();
    this.questions.release(binding.sessionId);
    this.bindings.delete(turnId);
  }

  /** Release everything a deleted session holds: its turn bindings, open questions, and remembered sketch versions. */
  closeSession(sessionId: string): void {
    for (const [turnId, binding] of this.bindings) if (binding.sessionId === sessionId) this.release(turnId);
    this.questions.release(sessionId);
    this.sketches.forgetSession(sessionId);
  }

  /** Release the turn's binding first, then queue the plan's turn-end transition. */
  settle(sessionId: string, turnId: string, outcome: PlanTurnOutcome): Promise<void> {
    this.release(turnId);
    return this.plans.settle(sessionId, turnId, outcome);
  }

  /** The standing instructions and the plan context for a runner that takes them in the prompt. */
  async promptForTurn(session: Pick<AgentSession, "id" | "runnerKind">): Promise<{ standing?: string; context?: string }> {
    const plan = await this.plans.promptForTurn(session);
    const sketch = this.sketches.advertised(session.runnerKind).length > 0 ? this.sketches.instruction : undefined;
    const standing = [plan.standing, sketch].filter((text): text is string => text !== undefined).join("\n\n");
    return { ...(standing ? { standing } : {}), ...(plan.context ? { context: plan.context } : {}) };
  }
}
