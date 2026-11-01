import Foundation

public struct LocalWorkspace: Codable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var path: String
    /// `user_selected`, `managed_throwaway` or `managed_worktree`; read as an
    /// open vocabulary, so a newer kind still decodes.
    public var kind: String
    public var trustedAt: String
    public var lastOpenedAt: String
    public var git: LocalWorkspaceGitSnapshot
    /// Set only on a `managed_worktree` workspace, a child thread's worktree.
    public var worktree: LocalWorkspaceWorktree?

    /// A child thread's worktree. Close unregisters it, so a registered one
    /// belongs to an open child; both apps decide from this one test.
    public var isChildWorktree: Bool { kind == "managed_worktree" }

    public init(
        id: String,
        name: String,
        path: String,
        kind: String,
        trustedAt: String,
        lastOpenedAt: String,
        git: LocalWorkspaceGitSnapshot,
        worktree: LocalWorkspaceWorktree? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.kind = kind
        self.trustedAt = trustedAt
        self.lastOpenedAt = lastOpenedAt
        self.git = git
        self.worktree = worktree
    }
}
