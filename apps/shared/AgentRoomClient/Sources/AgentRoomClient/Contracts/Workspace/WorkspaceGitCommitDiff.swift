import Foundation

public struct WorkspaceGitCommitDiff: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var commit: String
    public var parent: String?
    public var path: String
    public var before: String
    public var after: String
}
