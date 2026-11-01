import Foundation

/// The linked Git worktree a `managed_worktree` workspace lives in. The
/// backend mints every value when it creates a child thread.
public struct LocalWorkspaceWorktree: Codable, Hashable, Sendable {
    /// The registered workspace whose checkout the worktree was added from.
    public var parentWorkspaceId: String
    /// The worktree root. It differs from the workspace path when the parent
    /// is a registered subdirectory.
    public var worktreePath: String
    /// The child's branch, `agentroom/<slug>-<hex>`.
    public var branch: String
    /// The parent's HEAD commit when the worktree was added.
    public var baseCommit: String

    public init(parentWorkspaceId: String, worktreePath: String, branch: String, baseCommit: String) {
        self.parentWorkspaceId = parentWorkspaceId
        self.worktreePath = worktreePath
        self.branch = branch
        self.baseCommit = baseCommit
    }
}
