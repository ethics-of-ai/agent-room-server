import Foundation

public struct WorkspaceGitComparison: Codable, Hashable, Sendable {
    public var mergeBases: [String]
    public var leftOnly: [String]
    public var rightOnly: [String]
    public var truncated: Bool
}
