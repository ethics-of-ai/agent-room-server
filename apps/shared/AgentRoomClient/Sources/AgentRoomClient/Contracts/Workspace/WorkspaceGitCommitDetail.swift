import Foundation

public struct WorkspaceGitCommitDetail: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var commit: WorkspaceGitCommit
    public var parent: String?
    public var files: [WorkspaceGitCommitFile]
    public var truncated: Bool
    public var filtered: Bool
}
