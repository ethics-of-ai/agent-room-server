import type { AgentSessionRefusalCode } from "../agent/agentSessionTypes";
import type { WorkspaceGitRefusalCode } from "../workspace/git/errors";

/**
 * Every machine-readable reason a child-thread request refuses: the
 * service's own, a turn start's on a child, and the Git layer's for Land,
 * Update and Close. Routes send them as `code`, and the parent agent's tools
 * pass them through.
 */
export type ChildThreadRefusalCode =
  | "unknown_session"
  | "workspace_missing"
  | "parent_is_child"
  | "child_limit_reached"
  | "not_a_repository"
  | "unborn_head"
  | "runner_unavailable"
  | "runner_unsupported"
  | "unsupported_settings"
  | "worktree_add_failed"
  | "not_a_child"
  | "child_running"
  | "worktree_remove_failed"
  | "child_open"
  | "has_open_children"
  | "child_workspace"
  | AgentSessionRefusalCode
  | WorkspaceGitRefusalCode;

export class ChildThreadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: ChildThreadRefusalCode
  ) {
    super(message);
  }
}
