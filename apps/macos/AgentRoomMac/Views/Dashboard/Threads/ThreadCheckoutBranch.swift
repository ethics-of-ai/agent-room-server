import Foundation

/// The branch a thread runs on, which is the branch its workspace's checkout is on
/// right now. A thread owns no branch of its own: turns run on whatever the Mac is
/// on, and `AgentSession.gitBranch` only records where the latest turn started.
/// A closed child is the exception: Close removed its worktree and workspace,
/// so it names the branch its last turn ran on.
enum ThreadCheckoutBranch {
    static func label(for session: AgentSession, in snapshot: LocalWorkspaceRegistrySnapshot?) -> String {
        let workspace = snapshot?.workspaces.first { $0.id == session.workspaceId }
        if workspace == nil, session.parent != nil, session.closedAt != nil, let branch = session.gitBranch, !branch.isEmpty {
            return branch
        }
        return label(for: workspace)
    }

    static func label(for workspace: LocalWorkspace?) -> String {
        guard let workspace else { return "Branch unknown" }
        guard workspace.git.isRepository else { return "No Git branch" }
        return workspace.git.branch ?? "Detached HEAD"
    }
}
