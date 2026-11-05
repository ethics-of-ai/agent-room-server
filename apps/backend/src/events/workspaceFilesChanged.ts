import type { EventBus } from "./EventBus";
import type { WorkspaceFilesChangedPayload } from "./eventTypes";

/**
 * Publishes `workspace_files_changed`, live and outside the replay buffer. Both
 * publishers go through here so the payload has one shape: the tree watcher
 * for worktree changes and the HEAD watcher for index and ref changes.
 */
export function publishWorkspaceFilesChanged(
  eventBus: Pick<EventBus, "publishLive">,
  workspace: { id: string; path: string }
): void {
  const payload: WorkspaceFilesChangedPayload = { workspaceId: workspace.id, workspacePath: workspace.path };
  eventBus.publishLive("workspace_files_changed", payload);
}
