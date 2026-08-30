import Foundation

public struct LocalWorkspaceGitSnapshot: Codable, Hashable {
    public var isRepository: Bool
    public var branch: String?
    public var remote: String?
    /// True when any Git remote is configured, even when it is not named `origin`.
    public var hasRemote: Bool?
    public var branches: [LocalWorkspaceGitBranch]?
    public var hasUncommittedChanges: Bool?
    /// The current branch's upstream, e.g. `origin/main`, when it tracks one.
    public var upstream: String?
    /// True when the branch tracks an upstream that no longer exists on the remote.
    public var upstreamGone: Bool?
    /// Commits ahead of / behind the upstream **as of the last fetch**, which is
    /// why the client offers a Fetch control to refresh them.
    public var ahead: Int?
    public var behind: Int?

    public init(
        isRepository: Bool,
        branch: String?,
        remote: String?,
        hasRemote: Bool? = nil,
        branches: [LocalWorkspaceGitBranch]? = nil,
        hasUncommittedChanges: Bool? = nil,
        upstream: String? = nil,
        upstreamGone: Bool? = nil,
        ahead: Int? = nil,
        behind: Int? = nil
    ) {
        self.isRepository = isRepository
        self.branch = branch
        self.remote = remote
        self.hasRemote = hasRemote
        self.branches = branches
        self.hasUncommittedChanges = hasUncommittedChanges
        self.upstream = upstream
        self.upstreamGone = upstreamGone
        self.ahead = ahead
        self.behind = behind
    }

    /// True when the branch has no upstream yet, so pushing it means publishing it.
    public var needsPublish: Bool {
        isRepository && branch != nil && upstream == nil
    }
}
