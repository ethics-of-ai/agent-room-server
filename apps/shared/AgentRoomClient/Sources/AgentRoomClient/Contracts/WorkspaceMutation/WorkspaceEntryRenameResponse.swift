import Foundation

public struct WorkspaceEntryRenameResponse: Codable, Hashable {
    public var workspaceId: String
    public var oldPath: String
    public var path: String
    public var entryType: String
    public var sizeBytes: Int?
    public var renamed: Bool

    public init(
        workspaceId: String,
        oldPath: String,
        path: String,
        entryType: String,
        sizeBytes: Int? = nil,
        renamed: Bool
    ) {
        self.workspaceId = workspaceId
        self.oldPath = oldPath
        self.path = path
        self.entryType = entryType
        self.sizeBytes = sizeBytes
        self.renamed = renamed
    }
}
