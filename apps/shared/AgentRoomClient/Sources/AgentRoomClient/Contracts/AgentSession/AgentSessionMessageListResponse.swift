import Foundation

public struct AgentSessionMessageListResponse: Codable, Hashable {
    public var messages: [AgentSessionMessage]

    public init(messages: [AgentSessionMessage]) {
        self.messages = messages
    }
}
