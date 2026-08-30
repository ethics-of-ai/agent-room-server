import Foundation

public struct WorkspaceDirectoryCreateResponse: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    /// The new folder's mtime, so it is a rename, move, paste, or delete target
    /// straight away without waiting for the tree to reload.
    public var modifiedAt: String
    public var created: Bool

    public init(workspaceId: String, path: String, modifiedAt: String, created: Bool) {
        self.workspaceId = workspaceId
        self.path = path
        self.modifiedAt = modifiedAt
        self.created = created
    }
}
