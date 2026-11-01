import Foundation

/// A new child thread: its session, already running its first turn, and its
/// `managed_worktree` workspace.
public struct ChildThreadCreateResponse: Codable, Hashable {
    public var session: AgentSession
    public var workspace: LocalWorkspace

    public init(session: AgentSession, workspace: LocalWorkspace) {
        self.session = session
        self.workspace = workspace
    }
}
