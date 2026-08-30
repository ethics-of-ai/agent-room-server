import Foundation

public struct WorkspaceFilePreview: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var name: String
    public var sizeBytes: Int
    public var modifiedAt: String
    public var encoding: String
    public var content: String
    public var truncated: Bool
    public var previewable: Bool

    public init(
        workspaceId: String,
        path: String,
        name: String,
        sizeBytes: Int,
        modifiedAt: String,
        encoding: String,
        content: String,
        truncated: Bool,
        previewable: Bool
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.name = name
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.encoding = encoding
        self.content = content
        self.truncated = truncated
        self.previewable = previewable
    }
}
