import { allowedAgentToolLogicalIds } from "../agentTools/catalog";
import { prepareAgentRunnerToolSet, type PreparedAgentRunnerToolSet } from "../agentTools/runnerToolSet";
import type { AgentSession, AgentTurnContext, ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { AgentPlanChangedPayload } from "../events/eventTypes";
import type { AgentRunnerToolSet } from "../runner/AgentRunner";
import { isRegisteredRunnerKind, runnerDescriptor } from "../runner/registry";
import { runnerAgentToolCapabilities } from "../runner/shared/agentToolSets";
import {
  PLAN_SNAPSHOT_SCHEMA_VERSION,
  PLAN_TOOLS_INSTRUCTION,
  PLAN_TOOL_IDS,
  planToolHandlers,
  planTurnContext
} from "./planTools";
import {
  ThreadPlanService,
  durablePlanDocumentWriter,
  type PlanDocumentWriter,
  type PlanTurnOutcome
} from "./ThreadPlanService";

/**
 * Plan tools inside an agent session: which tools a runner's descriptor lets
 * the session advertise, a fresh binding per turn that dies the moment the turn
 * settles, and the plan prompt each turn carries. The plan service stays the
 * owner of state; this class only connects it to turns.
 */
export class ThreadPlanTurnTools {
  private readonly bindings = new Map<string, PreparedAgentRunnerToolSet>();

  constructor(
    private readonly plans: ThreadPlanService,
    private readonly runnerConfig?: ServiceConfig
  ) {}

  /**
   * The plan logical ids this runner's descriptor lets a session advertise.
   * Fails closed: a descriptor gated on configuration advertises nothing when
   * no configuration was supplied, and nothing is advertised without
   * acknowledged storage, where every call would report tools_unavailable.
   */
  advertised(runnerKind: string): string[] {
    if (!isRegisteredRunnerKind(runnerKind) || !this.plans.storageAvailable) return [];
    const planIds = new Set<string>(PLAN_TOOL_IDS);
    return allowedAgentToolLogicalIds({ gates: {}, capabilities: runnerAgentToolCapabilities(runnerKind, this.runnerConfig) })
      .filter((id) => planIds.has(id));
  }

  /** Why a turn that requires plan tools cannot start on this runner, or undefined when it can. */
  unsupportedReason(runnerKind: string, context: AgentTurnContext | undefined): string | undefined {
    if (context?.planToolsRequired !== true || this.advertised(runnerKind).length > 0) return undefined;
    const name = isRegisteredRunnerKind(runnerKind) ? runnerDescriptor(runnerKind).displayName : runnerKind;
    return `${name} does not support AgentRoom plan tools, which this turn requires`;
  }

  /** A fresh binding for one turn, or undefined when the runner advertises no plan tools. */
  bind(input: {
    session: Pick<AgentSession, "id" | "runnerKind">;
    turnId: string;
    context: AgentTurnContext | undefined;
    isLive(): boolean;
  }): AgentRunnerToolSet | undefined {
    const allowed = this.advertised(input.session.runnerKind);
    if (allowed.length === 0) return undefined;
    const prepared = prepareAgentRunnerToolSet({
      runId: input.turnId,
      sessionKey: input.session.id,
      catalog: allowed,
      allowed,
      required: input.context?.planToolsRequired === true,
      handlers: planToolHandlers(this.plans, input.session.id),
      isLive: input.isLive
    });
    this.bindings.set(input.turnId, prepared);
    return { ...prepared.tools, instructions: PLAN_TOOLS_INSTRUCTION };
  }

  /** End a turn's binding. Later calls, and results that settle after this, are refused. */
  release(turnId: string): void {
    this.bindings.get(turnId)?.dispose();
    this.bindings.delete(turnId);
  }

  /** Release the turn's binding first, then queue the plan's turn-end transition. */
  settle(sessionId: string, turnId: string, outcome: PlanTurnOutcome): Promise<void> {
    this.release(turnId);
    return this.plans.settleTurn(sessionId, turnId, outcome);
  }

  /**
   * The standing instruction and the per-turn context. Reads through the plan
   * service's queue, so a settlement still in flight lands before the context
   * is built. A runner that offers no plan tools and a thread with no plan get
   * nothing.
   */
  async promptForTurn(session: Pick<AgentSession, "id" | "runnerKind">): Promise<{ standing?: string; context?: string }> {
    const advertised = this.advertised(session.runnerKind).length > 0;
    const read = await this.plans.read(session.id);
    const plan = read.kind === "ok" ? read.plan : "unavailable";
    if (!advertised && plan === null) return {};
    return {
      ...(advertised ? { standing: PLAN_TOOLS_INSTRUCTION } : {}),
      context: planTurnContext({ availability: advertised ? "advertised" : "unavailable", plan })
    };
  }
}

/** Build a session's plan service and turn tools, publishing metadata-only change events. */
export function createSessionPlans(input: {
  eventBus: Pick<EventBus, "publish">;
  store?: Parameters<typeof durablePlanDocumentWriter>[0];
  snapshot: Parameters<typeof durablePlanDocumentWriter>[1];
  runnerConfig?: ServiceConfig;
}): { plans: ThreadPlanService; planTools: ThreadPlanTurnTools } {
  const writer: PlanDocumentWriter | undefined = input.store ? durablePlanDocumentWriter(input.store, input.snapshot) : undefined;
  const plans = new ThreadPlanService({
    ...(writer ? { writer } : {}),
    onChanged: (change) => {
      const payload: AgentPlanChangedPayload = { schemaVersion: PLAN_SNAPSHOT_SCHEMA_VERSION, ...change };
      input.eventBus.publish("agent_plan_changed", payload);
    }
  });
  return { plans, planTools: new ThreadPlanTurnTools(plans, input.runnerConfig) };
}
