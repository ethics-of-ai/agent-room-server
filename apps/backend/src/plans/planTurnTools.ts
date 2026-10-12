import { allowedAgentToolLogicalIds } from "../agentTools/catalog";
import type { AgentToolHandler } from "../agentTools/dispatch";
import type { AgentSession, AgentTurnContext, ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { AgentPlanChangedPayload } from "../events/eventTypes";
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
 * the session advertise, the handlers the session's tool composer binds per
 * turn, and the plan prompt each turn carries. The plan service stays the
 * owner of state; this class only connects it to turns.
 */
export class ThreadPlanTurnTools {
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

  /** The plan handlers for one turn; the session's tool composer binds them. */
  handlers(sessionId: string): Record<string, AgentToolHandler> {
    return planToolHandlers(this.plans, sessionId);
  }

  get instruction(): string {
    return PLAN_TOOLS_INSTRUCTION;
  }

  /** Queue the plan's turn-end transition. The composer has already released the turn's binding. */
  settle(sessionId: string, turnId: string, outcome: PlanTurnOutcome): Promise<void> {
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
