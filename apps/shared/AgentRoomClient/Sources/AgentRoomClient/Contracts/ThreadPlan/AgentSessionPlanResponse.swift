import Foundation

/// `GET /api/agent-sessions/:id/plan`. `plan` is nil when the thread has no
/// plan. Mutation receipts never leave the backend.
public struct AgentSessionPlanResponse: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var plan: ThreadPlan?

    public init(schemaVersion: Int, plan: ThreadPlan?) {
        self.schemaVersion = schemaVersion
        self.plan = plan
    }
}
