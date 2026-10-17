import type { EventBus } from "./EventBus";
import type { WorkspaceBranchChangedPayload } from "./eventTypes";

export interface WorkspaceBranchChange {
  workspace: { id: string; path: string };
  previousBranch?: string;
  /** The branch the checkout is on now; null is a detached HEAD. */
  branch: string | null;
  origin?: "observed";
}

/**
 * Publishes `workspace_branch_changed`. Every publisher goes through here so the
 * payload has one shape: AgentRoom's own switches and the HEAD watcher's.
 */
export function publishWorkspaceBranchChanged(
  eventBus: Pick<EventBus, "publish">,
  change: WorkspaceBranchChange
): void {
  const payload: WorkspaceBranchChangedPayload = {
    workspaceId: change.workspace.id,
    path: change.workspace.path,
    ...(change.previousBranch ? { previousBranch: change.previousBranch } : {}),
    ...(change.branch ? { branch: change.branch } : { detached: true }),
    ...(change.origin ? { origin: change.origin } : {})
  };
  eventBus.publish("workspace_branch_changed", payload);
}
