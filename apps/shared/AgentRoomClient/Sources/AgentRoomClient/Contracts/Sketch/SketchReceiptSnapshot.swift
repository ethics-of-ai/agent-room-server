import Foundation

/// The durable acknowledgement of one applied sketch transaction. Retrying
/// the same request id replays this receipt rather than committing twice.
public struct SketchReceiptSnapshot: Codable, Hashable {
    public var requestId: String
    public var transactionId: String
    public var revision: Int
    public var kind: String
    public var actor: SketchActorSnapshot
    public var turnId: String?
    public var label: String
    public var requestFingerprint: String

    public init(
        requestId: String,
        transactionId: String,
        revision: Int,
        kind: String,
        actor: SketchActorSnapshot,
        turnId: String? = nil,
        label: String,
        requestFingerprint: String
    ) {
        self.requestId = requestId
        self.transactionId = transactionId
        self.revision = revision
        self.kind = kind
        self.actor = actor
        self.turnId = turnId
        self.label = label
        self.requestFingerprint = requestFingerprint
    }
}
