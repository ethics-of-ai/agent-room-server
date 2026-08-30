import Foundation

public struct WorkspaceEntryRenameRequest: Codable, Hashable {
    public var path: String
    public var newName: String
    public var baseModifiedAt: String

    public init(path: String, newName: String, baseModifiedAt: String) {
        self.path = path
        self.newName = newName
        self.baseModifiedAt = baseModifiedAt
    }
}
