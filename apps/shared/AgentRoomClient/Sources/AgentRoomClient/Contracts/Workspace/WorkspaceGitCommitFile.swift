import Foundation

public struct WorkspaceGitCommitFile: Codable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    public var status: String
    public var previewable: Bool
}
