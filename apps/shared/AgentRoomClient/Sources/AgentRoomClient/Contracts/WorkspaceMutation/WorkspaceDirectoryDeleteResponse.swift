import Foundation

public struct WorkspaceDirectoryDeleteResponse: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var fileCount: Int
    public var directoryCount: Int
    public var sizeBytes: Int
    public var deleted: Bool

    public init(
        workspaceId: String,
        path: String,
        fileCount: Int,
        directoryCount: Int,
        sizeBytes: Int,
        deleted: Bool
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.fileCount = fileCount
        self.directoryCount = directoryCount
        self.sizeBytes = sizeBytes
        self.deleted = deleted
    }
}
