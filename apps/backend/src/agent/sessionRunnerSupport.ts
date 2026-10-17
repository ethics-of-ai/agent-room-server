import type { EventBus } from "../events/EventBus";
import { publishWorkspaceBranchChanged } from "../events/workspaceBranchChanged";
import { AgentRunnerInputError, type AgentRunner, type AgentRunnerInputPart } from "../runner/AgentRunner";
import {
  LocalWorkspaceRegistryError,
  type CheckoutLocalWorkspaceBranchResult,
  type LocalWorkspaceRegistry
} from "../workspace/LocalWorkspaceRegistry";
import { AgentSessionError } from "./agentSessionTypes";

/**
 * Check out the branch a session create names, announcing a change and mapping
 * registry refusals to session errors. It is the one place a session moves the
 * checkout: turns run on whatever branch the Mac is on and never switch it.
 */
export async function checkoutSessionBranch(
  deps: { registry: LocalWorkspaceRegistry; eventBus: EventBus },
  workspaceId: string,
  branch: string
): Promise<CheckoutLocalWorkspaceBranchResult> {
  try {
    const result = await deps.registry.checkoutBranch(workspaceId, branch);
    if (result.changed) {
      publishWorkspaceBranchChanged(deps.eventBus, {
        workspace: result.workspace,
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
