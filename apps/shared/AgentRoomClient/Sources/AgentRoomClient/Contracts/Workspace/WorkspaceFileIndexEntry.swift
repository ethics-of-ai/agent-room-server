import Foundation

/// One file in the bounded workspace file index that backs quick-open and the
/// `@` mention picker. Carries path metadata only — never file content.
/// `previewable` means the same thing as the tree read's flag: a non-secret,
/// text-openable file within the backend write cap, so the editor can open and
/// save it.
public struct WorkspaceFileIndexEntry: Codable, Hashable, Identifiable {
    public var path: String
    public var name: String
    public var previewable: Bool

    public var id: String { path }

    public init(path: String, name: String, previewable: Bool) {
        self.path = path
        self.name = name
        self.previewable = previewable
    }
}
