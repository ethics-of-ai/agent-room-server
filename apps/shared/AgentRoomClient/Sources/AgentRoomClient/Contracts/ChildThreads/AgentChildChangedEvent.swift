import Foundation

/// `agent_child_changed`: a parent thread's child was created, landed, updated
/// or closed. Ids only; read the children again for the summary. A child's
/// status changes arrive as ordinary turn events with the child's `sessionId`.
public struct AgentChildChangedEvent: Hashable, Sendable {
    public static let eventType = "agent_child_changed"

    public var parentSessionId: String
    public var childSessionId: String
    /// `created`, `landed`, `updated` or `closed`.
    public var change: String
    /// Set on `created`: `button`, `offer` or `person_asked`.
    public var initiation: String?

    public init(parentSessionId: String, childSessionId: String, change: String, initiation: String? = nil) {
        self.parentSessionId = parentSessionId
        self.childSessionId = childSessionId
        self.change = change
        self.initiation = initiation
    }

    /// The typed payload, or nil for another event type or a payload missing a
    /// required field.
    public init?(event: AgentRoomEvent) {
        guard event.type == Self.eventType,
              let object = event.payload.objectValue,
              let parentSessionId = object["parentSessionId"]?.stringValue,
              let childSessionId = object["childSessionId"]?.stringValue,
              let change = object["change"]?.stringValue else {
            return nil
        }
        self.init(
            parentSessionId: parentSessionId,
            childSessionId: childSessionId,
            change: change,
            initiation: object["initiation"]?.stringValue
        )
    }
}
