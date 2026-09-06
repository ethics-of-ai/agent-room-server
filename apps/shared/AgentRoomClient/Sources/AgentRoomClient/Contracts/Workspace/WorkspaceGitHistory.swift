import Foundation

public struct WorkspaceGitHistory: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var isRepository: Bool
    public var head: String?
    public var selectedRef: String?
    public var comparisonRef: String?
    public var upstreamRef: String?
    public var refs: [WorkspaceGitRef]
    public var refsTruncated: Bool
    public var commits: [WorkspaceGitCommit]
    public var truncated: Bool
    public var shallow: Bool
    public var comparison: WorkspaceGitComparison?
    public var refreshedAt: String
}
