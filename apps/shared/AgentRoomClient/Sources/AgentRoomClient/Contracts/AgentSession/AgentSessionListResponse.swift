import Foundation

public struct AgentSessionListResponse: Codable, Hashable {
    public var sessions: [AgentSession]

    public init(sessions: [AgentSession]) {
        self.sessions = sessions
    }
}
