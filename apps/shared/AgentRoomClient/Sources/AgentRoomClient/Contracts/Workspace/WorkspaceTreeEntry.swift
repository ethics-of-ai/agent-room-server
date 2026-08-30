import Foundation

public struct WorkspaceTreeEntry: Codable, Hashable, Identifiable {
    public var type: String
    public var name: String
    public var path: String
    public var sizeBytes: Int?
    public var modifiedAt: String?
    public var previewable: Bool?
    public var children: [WorkspaceTreeEntry]?

    public var id: String { path }
    public var isDirectory: Bool { type == "directory" }
    public var isPreviewableFile: Bool { !isDirectory && previewable == true }

    public init(
        type: String,
        name: String,
        path: String,
        sizeBytes: Int? = nil,
        modifiedAt: String? = nil,
        previewable: Bool? = nil,
        children: [WorkspaceTreeEntry]? = nil
    ) {
        self.type = type
        self.name = name
        self.path = path
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.previewable = previewable
        self.children = children
    }
}
