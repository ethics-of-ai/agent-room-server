import Foundation

public struct WorkspaceTreeSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var entries: [WorkspaceTreeEntry]

    public init(workspaceId: String, path: String, entries: [WorkspaceTreeEntry]) {
        self.workspaceId = workspaceId
        self.path = path
        self.entries = entries
    }
}
