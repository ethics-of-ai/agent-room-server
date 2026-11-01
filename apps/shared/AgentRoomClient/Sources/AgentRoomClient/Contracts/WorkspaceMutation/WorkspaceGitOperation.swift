import Foundation

/// The fixed set of mutating git operations the backend runs. Nothing here
/// rewrites history: there is no amend, reset, rebase, or forced push, and pull
/// is fast-forward only. The workspace Git routes run the first nine. Child
/// threads run the last five: the backend adds and removes a child's worktree
/// and branch itself, Land answers with `mergeFastForward` and Update from
/// parent with `updateFromParent`. See docs/safety/TRUST_AND_SAFETY.md.
public enum WorkspaceGitOperation: String, Codable, Hashable, Sendable {
    case stage
    case unstage
    case discard
    case commit
    case fetch
    case pull
    case push
    case createBranch = "create_branch"
    case switchBranch = "switch_branch"
    case worktreeAdd = "worktree_add"
    case worktreeRemove = "worktree_remove"
    case branchDelete = "branch_delete"
    case mergeFastForward = "merge_ff"
    case updateFromParent = "update_from_parent"
}
