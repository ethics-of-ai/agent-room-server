import Foundation

public struct WorkspaceGitRef: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var commit: String
    public var current: Bool
    public var kind: String
}
