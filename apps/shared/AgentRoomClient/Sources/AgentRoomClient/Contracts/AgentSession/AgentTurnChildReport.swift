import Foundation

/// One child turn that settled, as a `child_report` trigger names it to the
/// parent thread.
public struct AgentTurnChildReport: Codable, Hashable, Sendable {
    public var childSessionId: String
    public var turnId: String
    /// `succeeded`, `failed` or `cancelled`.
    public var status: String

    public init(childSessionId: String, turnId: String, status: String) {
        self.childSessionId = childSessionId
        self.turnId = turnId
        self.status = status
    }
}
