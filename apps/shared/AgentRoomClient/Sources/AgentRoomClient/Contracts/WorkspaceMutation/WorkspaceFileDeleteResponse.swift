import Foundation

public struct WorkspaceFileDeleteResponse: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var sizeBytes: Int
    public var deleted: Bool

    public init(workspaceId: String, path: String, sizeBytes: Int, deleted: Bool) {
        self.workspaceId = workspaceId
        self.path = path
        self.sizeBytes = sizeBytes
        self.deleted = deleted
    }
}
