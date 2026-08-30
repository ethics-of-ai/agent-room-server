import Foundation

public struct SendAgentTurnRequest: Codable, Hashable {
    public var message: String
    public var context: AgentTurnContext?
    public var settings: CodingAgentTurnSettings?

    public init(
        message: String,
        context: AgentTurnContext?,
        settings: CodingAgentTurnSettings? = nil
    ) {
        self.message = message
        self.context = context
        self.settings = settings
    }
}
