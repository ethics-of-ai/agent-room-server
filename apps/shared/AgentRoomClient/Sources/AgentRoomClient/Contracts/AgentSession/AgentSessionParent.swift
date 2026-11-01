import Foundation

/// The parent thread a child session belongs to. Set only on a child thread.
public struct AgentSessionParent: Codable, Hashable, Sendable {
    public var sessionId: String
    public var workspaceId: String
    /// The parent agent's start tool call id, when its agent started the child.
    public var operationId: String?

    public init(sessionId: String, workspaceId: String, operationId: String? = nil) {
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.operationId = operationId
    }
}
