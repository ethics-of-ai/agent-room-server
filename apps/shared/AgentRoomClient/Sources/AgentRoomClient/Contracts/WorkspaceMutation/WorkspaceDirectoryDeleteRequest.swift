import Foundation

public struct WorkspaceDirectoryDeleteRequest: Codable, Hashable {
    public var path: String
    public var baseModifiedAt: String

    public init(path: String, baseModifiedAt: String) {
        self.path = path
        self.baseModifiedAt = baseModifiedAt
    }
}
