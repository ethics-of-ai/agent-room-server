import Foundation

/// What a `sketch_document_changed` event reports.
public enum SketchDocumentChangeKind: String, Hashable, Sendable {
    case created
    case commit
    case undo
    case redo
    case renamed
    case deleted
}
