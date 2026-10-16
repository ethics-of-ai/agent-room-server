import type { EventBus } from "../events/EventBus";
import { AgentRunnerInputError, type AgentRunner, type AgentRunnerInputPart } from "../runner/AgentRunner";
import {
  LocalWorkspaceRegistryError,
  type CheckoutLocalWorkspaceBranchResult,
  type LocalWorkspaceRegistry
} from "../workspace/LocalWorkspaceRegistry";
import { AgentSessionError } from "./agentSessionTypes";

/** Check out a session's branch, announcing a change and mapping registry refusals to session errors. */
export async function checkoutSessionBranch(
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
