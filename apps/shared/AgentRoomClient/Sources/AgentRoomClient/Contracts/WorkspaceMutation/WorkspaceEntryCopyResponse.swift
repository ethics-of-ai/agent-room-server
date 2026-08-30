import Foundation

public struct WorkspaceEntryCopyResponse: Codable, Hashable {
    public var workspaceId: String
    public var sourcePath: String
    public var path: String
    public var entryType: String
    public var fileCount: Int
    public var directoryCount: Int
    public var sizeBytes: Int
    public var copied: Bool

    public init(
        workspaceId: String,
        sourcePath: String,
        path: String,
        entryType: String,
        fileCount: Int,
        directoryCount: Int,
        sizeBytes: Int,
        copied: Bool
    ) {
        self.workspaceId = workspaceId
        self.sourcePath = sourcePath
        self.path = path
        self.entryType = entryType
        self.fileCount = fileCount
        self.directoryCount = directoryCount
        self.sizeBytes = sizeBytes
        self.copied = copied
    }
}
