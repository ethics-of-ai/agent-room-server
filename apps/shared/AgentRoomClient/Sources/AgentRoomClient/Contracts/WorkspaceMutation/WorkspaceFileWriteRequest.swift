import Foundation

public struct WorkspaceFileWriteRequest: Codable, Hashable {
    public var path: String
    public var content: String
    public var baseModifiedAt: String?

    public init(path: String, content: String, baseModifiedAt: String? = nil) {
        self.path = path
        self.content = content
        self.baseModifiedAt = baseModifiedAt
    }
}
