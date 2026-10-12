import Foundation

/// `sketch_document_changed`: a repository sketch reached a new durable
/// revision. Metadata only; geometry is re-read through the sketch routes.
/// An agent change names the session and turn that made it, so a client can
/// say which thread is editing. A human change carries neither.
public struct SketchDocumentChangedEvent: Hashable, Sendable {
    public static let eventType = "sketch_document_changed"

    public var workspaceId: String
    public var path: String
    public var sketchId: String?
    public var revision: Int?
    /// Nil when the event names no kind or one this client does not know,
    /// so a newer backend's kinds still route as a generic change.
    public var kind: SketchDocumentChangeKind?
    /// Nil when the backend sent an actor kind this client does not know.
    public var actorKind: SketchActorKind?
    public var sessionId: String?
    public var turnId: String?
    /// The path a `renamed` sketch had before.
    public var previousPath: String?

    public init(
        workspaceId: String,
        path: String,
        sketchId: String? = nil,
        revision: Int? = nil,
        kind: SketchDocumentChangeKind? = nil,
        actorKind: SketchActorKind? = nil,
        sessionId: String? = nil,
        turnId: String? = nil,
        previousPath: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.sketchId = sketchId
        self.revision = revision
        self.kind = kind
        self.actorKind = actorKind
        self.sessionId = sessionId
        self.turnId = turnId
        self.previousPath = previousPath
    }

    /// The typed payload, or nil for another event type or a payload without
    /// its workspace and path.
    public init?(event: AgentRoomEvent) {
        guard event.type == Self.eventType,
              let object = event.payload.objectValue,
              let workspaceId = object["workspaceId"]?.stringValue,
              let path = object["path"]?.stringValue else {
            return nil
        }
        self.init(
            workspaceId: workspaceId,
            path: path,
            sketchId: object["sketchId"]?.stringValue,
            revision: object["revision"]?.intValue,
            kind: object["kind"]?.stringValue.flatMap(SketchDocumentChangeKind.init(rawValue:)),
            actorKind: object["actorKind"]?.stringValue.flatMap(SketchActorKind.init(rawValue:)),
            sessionId: object["sessionId"]?.stringValue,
            turnId: object["turnId"]?.stringValue,
            previousPath: object["previousPath"]?.stringValue
        )
    }
}
