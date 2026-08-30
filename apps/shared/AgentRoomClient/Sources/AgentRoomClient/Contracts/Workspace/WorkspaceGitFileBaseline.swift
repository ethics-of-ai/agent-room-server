import Foundation

/// The git HEAD version of a workspace file, used to diff the working tree
/// against the committed baseline. A file not yet in HEAD and a non-repository
/// workspace are ordinary data states (`existsInHead` / `isRepository` false),
/// not errors; `content` is present only for an in-cap UTF-8 blob.
public struct WorkspaceGitFileBaseline: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var ref: String
    public var isRepository: Bool
    public var existsInHead: Bool
    public var sizeBytes: Int?
    public var encoding: String?
    public var content: String?
    public var truncated: Bool?

    public var hasUsableContent: Bool {
        isRepository && existsInHead && truncated != true && content != nil
    }

    public init(
        workspaceId: String,
        path: String,
        ref: String,
        isRepository: Bool,
        existsInHead: Bool,
        sizeBytes: Int? = nil,
        encoding: String? = nil,
        content: String? = nil,
        truncated: Bool? = nil
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.ref = ref
        self.isRepository = isRepository
        self.existsInHead = existsInHead
        self.sizeBytes = sizeBytes
        self.encoding = encoding
        self.content = content
        self.truncated = truncated
    }
}
