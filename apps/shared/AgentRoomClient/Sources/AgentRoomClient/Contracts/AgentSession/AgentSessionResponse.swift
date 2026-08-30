import Foundation

public struct AgentSessionResponse: Codable, Hashable {
    public var session: AgentSession

    public init(session: AgentSession) {
        self.session = session
    }
}
