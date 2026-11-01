import Foundation

/// `GET /api/agent-sessions/:sessionId/children`.
public struct ChildThreadListResponse: Codable, Hashable, Sendable {
    public var children: [ChildThreadSummary]
    /// False when the parent's thread lacks the AgentRoom child tools, so its
    /// agent cannot see its children. The person's actions work either way.
    public var parentToolsAvailable: Bool
    /// Child reports the wake budget or a parent that cannot continue held
    /// back. They ride the person's next turn on the parent. Nil from a
    /// backend older than report-back wakes.
    public var waitingReports: Int?

    public init(children: [ChildThreadSummary], parentToolsAvailable: Bool, waitingReports: Int? = nil) {
        self.children = children
        self.parentToolsAvailable = parentToolsAvailable
        self.waitingReports = waitingReports
    }
}
