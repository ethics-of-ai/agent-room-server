/**
 * Machine-readable reasons a child worktree operation refuses, for a route to
 * pass on beside Git's own text.
 */
export type WorkspaceGitRefusalCode =
  | "child_dirty"
  | "child_not_linked"
  | "not_fast_forward"
  | "parent_changes_in_the_way"
  | "parent_detached"
  | "update_conflicted"
  | "update_interrupted";

/**
 * The refusal type every fixed Git operation raises. It carries the status the
 * route replies with, so "this path is not eligible" and "git itself failed"
 * stay distinguishable without the route reading messages.
 */
export class WorkspaceGitServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code?: WorkspaceGitRefusalCode
  ) {
    super(message);
  }
}
