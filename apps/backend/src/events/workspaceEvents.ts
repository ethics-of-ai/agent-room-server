import type { LocalWorkspace, LocalWorkspaceGitOperationResult } from "../domain/models";
import type { EventBus } from "./EventBus";
import type { WorkspaceGitOperationPayload } from "./eventTypes";

/**
 * The workspace lifecycle and Git operation events. The routes and the
 * child-thread service both publish them, and the HEAD watcher and sketch
 * index act on them, so every publisher goes through here and each payload
 * has one shape.
 */

/**
 * Publishes `workspace_git_operation`, sanitized: identifiers, the operation,
 * the branch and commit it produced, and counts. Never file content, never a
 * path list, and never a remote URL, which can carry credentials in its
 * userinfo; a remote travels by name only.
 */
export function publishWorkspaceGitOperation(
  eventBus: Pick<EventBus, "publish">,
  result: LocalWorkspaceGitOperationResult
): void {
  const payload: WorkspaceGitOperationPayload = {
    workspaceId: result.workspaceId,
    workspacePath: result.workspace.path,
    operation: result.operation,
    ...(result.branch ? { branch: result.branch } : {}),
    ...(result.previousBranch ? { previousBranch: result.previousBranch } : {}),
    ...(result.commit ? { commit: result.commit } : {}),
    ...(result.remote ? { remote: result.remote } : {}),
    fileCount: result.paths?.length ?? 0,
    changedFileCount: result.status.counts.total
  };
  eventBus.publish("workspace_git_operation", payload);
}

export function publishWorkspaceRegistered(
  eventBus: Pick<EventBus, "publish">,
  workspace: Pick<LocalWorkspace, "id" | "path" | "kind">,
  created: boolean
): void {
  eventBus.publish("workspace_registered", { workspaceId: workspace.id, path: workspace.path, kind: workspace.kind, created });
}

export function publishWorkspaceRemoved(
  eventBus: Pick<EventBus, "publish">,
  workspace: Pick<LocalWorkspace, "id" | "path" | "kind">
): void {
  eventBus.publish("workspace_removed", { workspaceId: workspace.id, path: workspace.path, kind: workspace.kind });
}
