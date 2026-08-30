import Foundation

public struct WorkspaceEntryMoveResponse: Codable, Hashable {
    public var workspaceId: String
    public var oldPath: String
    public var path: String
    public var entryType: String
    public var sizeBytes: Int?
    public var moved: Bool

    public init(
        workspaceId: String,
        oldPath: String,
        path: String,
        entryType: String,
        sizeBytes: Int? = nil,
        moved: Bool
    ) {
        self.workspaceId = workspaceId
        self.oldPath = oldPath
        self.path = path
        self.entryType = entryType
        self.sizeBytes = sizeBytes
        self.moved = moved
    }
}
