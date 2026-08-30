import Foundation

public struct AgentSessionMessage: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var turnId: String?
    public var role: String
    public var content: String
    public var context: AgentSessionMessageContext?
    public var status: String
    public var at: String

    public init(
        id: String,
        sessionId: String,
        turnId: String?,
        role: String,
        content: String,
        context: AgentSessionMessageContext?,
        status: String,
        at: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.role = role
        self.content = content
        self.context = context
        self.status = status
        self.at = at
    }

    public init(
        id: String,
        sessionId: String,
        turnId: String?,
        role: String,
        content: String,
        status: String,
        at: String
    ) {
        self.init(
            id: id,
            sessionId: sessionId,
            turnId: turnId,
            role: role,
            content: content,
            context: nil,
            status: status,
            at: at
        )
    }
}
