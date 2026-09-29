import Foundation

/// `agent_plan_changed`: the backend committed a change to a thread's plan.
/// Metadata only; the plan text is read from `GET /api/agent-sessions/:id/plan`.
/// `revision` orders snapshots of one `planId` only, because a replacement plan
/// starts again at revision 1.
public struct AgentPlanChangedEvent: Codable, Hashable, Sendable {
    public static let eventType = "agent_plan_changed"

    public var schemaVersion: Int
    public var sessionId: String
    public var planId: String
    public var revision: Int

    public init(schemaVersion: Int, sessionId: String, planId: String, revision: Int) {
        self.schemaVersion = schemaVersion
        self.sessionId = sessionId
        self.planId = planId
        self.revision = revision
    }

    /// The typed payload, or nil for another event type or a payload missing a
    /// required field.
    public init?(event: AgentRoomEvent) {
        guard event.type == Self.eventType,
              let object = event.payload.objectValue,
              let schemaVersion = object["schemaVersion"]?.intValue,
              let sessionId = object["sessionId"]?.stringValue,
              let planId = object["planId"]?.stringValue,
              let revision = object["revision"]?.intValue else {
            return nil
        }
        self.init(schemaVersion: schemaVersion, sessionId: sessionId, planId: planId, revision: revision)
    }
}
