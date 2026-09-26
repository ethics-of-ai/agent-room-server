import Foundation

/// `POST /api/agent-sessions/:sessionId/repository-sketch/undo` and `.../redo`. Undo
/// applies the history head's inverse as a fresh compensating transaction, so
/// it needs the same revision lock and idempotency key a commit does.
public struct SketchUndoRedoRequest: Encodable, Hashable {
    public var requestId: String
    public var baseRevision: Int
    public var fileVersion: String?
    public var label: String?

    public init(
        requestId: String,
        baseRevision: Int,
        fileVersion: String? = nil,
        label: String? = nil
    ) {
        self.requestId = requestId
        self.baseRevision = baseRevision
        self.fileVersion = fileVersion
        self.label = label
    }
}
