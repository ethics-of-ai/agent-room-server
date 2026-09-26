import Foundation

/// The session's sketch as the create and read routes return it: the document
/// plus the metadata the volume surfaces (revision, undo/redo depths, and the
/// timestamps that distinguish a stored sketch from a fresh one).
public struct SketchSessionSnapshot: Codable, Hashable {
    public var sketchId: String
    public var revision: Int
    public var document: SketchDocumentSnapshot
    public var undoDepth: Int
    public var redoDepth: Int
    public var createdAt: String?
    public var updatedAt: String?

    public var workspaceId: String?
    public var path: String?
    public var fileVersion: String?
    public var historyReset: Bool?
    public var outcomeUnknown: Bool?

    public init(
        sketchId: String,
        revision: Int,
        document: SketchDocumentSnapshot,
        undoDepth: Int,
        redoDepth: Int,
        createdAt: String,
        updatedAt: String,
        workspaceId: String? = nil,
        path: String? = nil,
        fileVersion: String? = nil,
        historyReset: Bool? = nil,
        outcomeUnknown: Bool? = nil
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.fileVersion = fileVersion
        self.historyReset = historyReset
        self.outcomeUnknown = outcomeUnknown
        self.sketchId = sketchId
        self.revision = revision
        self.document = document
        self.undoDepth = undoDepth
        self.redoDepth = redoDepth
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
