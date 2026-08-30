import Foundation

public struct LocalWorkspaceGitStatus: Codable, Hashable {
    public var workspaceId: String
    public var isRepository: Bool
    public var branch: String?
    public var clean: Bool
    public var counts: LocalWorkspaceGitStatusCounts
    public var files: [LocalWorkspaceGitChangedFile]
    public var truncated: Bool
    public var refreshedAt: String

    public init(
        workspaceId: String,
        isRepository: Bool,
        branch: String? = nil,
        clean: Bool,
        counts: LocalWorkspaceGitStatusCounts,
        files: [LocalWorkspaceGitChangedFile],
        truncated: Bool,
        refreshedAt: String
    ) {
        self.workspaceId = workspaceId
        self.isRepository = isRepository
        self.branch = branch
        self.clean = clean
        self.counts = counts
        self.files = files
        self.truncated = truncated
        self.refreshedAt = refreshedAt
    }
}
