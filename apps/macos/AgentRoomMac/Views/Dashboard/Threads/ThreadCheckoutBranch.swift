import Foundation

/// The branch a thread runs on, which is the branch its workspace's checkout is on
/// right now. A thread owns no branch of its own: turns run on whatever the Mac is
/// on, and `AgentSession.gitBranch` only records where the latest turn started.
enum ThreadCheckoutBranch {
    static func label(for session: AgentSession, in snapshot: LocalWorkspaceRegistrySnapshot?) -> String {
        label(for: snapshot?.workspaces.first { $0.id == session.workspaceId })
    }

    static func label(for workspace: LocalWorkspace?) -> String {
        guard let workspace else { return "Branch unknown" }
        guard workspace.git.isRepository else { return "No Git branch" }
        return workspace.git.branch ?? "Detached HEAD"
    }
}
