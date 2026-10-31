import Foundation

/// A versioned sketch document: the wire form both the read route and the
/// session snapshot embed. The revision is the whole-document optimistic-lock
/// token every commit, undo, and redo must repeat.
public struct SketchDocumentSnapshot: Codable, Hashable {
    public var schemaVersion: Int
    public var kind: String
    public var sketchId: String
    public var revision: Int
    /// The table pieces stand on; nil reads as the default cell size.
    public var table: SketchTable?
    public var objects: [SketchObjectSnapshot]

    public init(
        schemaVersion: Int,
        kind: String,
        sketchId: String,
        revision: Int,
        table: SketchTable? = nil,
        objects: [SketchObjectSnapshot]
    ) {
        self.schemaVersion = schemaVersion
        self.kind = kind
        self.sketchId = sketchId
        self.revision = revision
        self.table = table
        self.objects = objects
    }
}
