import Foundation

public struct WorkspaceGitCommit: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var parents: [String]
    public var subject: String
    public var author: String
    public var committedAt: String
}
