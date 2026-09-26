import Foundation

/// `POST /api/agent-sessions/:sessionId/repository-sketch/commits`: one all-or-nothing
/// batch. `requestId` is the caller's idempotency key, `baseRevision` the
/// whole-document optimistic lock, and `label` the human-readable summary the
/// undo surface shows. The actor is derived server-side and deliberately has
/// no field here — an envelope carrying one is refused.
public struct SketchCommitRequest: Encodable, Hashable {
    public var requestId: String
    public var baseRevision: Int
    public var fileVersion: String?
    public var label: String?
    public var operations: [SketchCommitOperation]

    public init(
        requestId: String,
        baseRevision: Int,
        fileVersion: String? = nil,
        label: String? = nil,
        operations: [SketchCommitOperation]
    ) {
        self.requestId = requestId
        self.baseRevision = baseRevision
        self.fileVersion = fileVersion
        self.label = label
        self.operations = operations
    }
}
