import Foundation

public struct AgentSessionTurn: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var status: String
    public var startedAt: String
    public var completedAt: String?
    public var lastMessage: String?
    public var error: String?
    public var inputTokens: Int
    public var outputTokens: Int
    public var totalTokens: Int
    public var modelContextWindowTokens: Int?
    /// The threshold this turn read, on the same terms as the session's copy.
    public var contextCompactionThresholdTokens: Int?

    public init(
        id: String,
        sessionId: String,
        status: String,
        startedAt: String,
        completedAt: String?,
        lastMessage: String?,
        error: String?,
        inputTokens: Int,
        outputTokens: Int,
        totalTokens: Int,
        modelContextWindowTokens: Int? = nil,
        contextCompactionThresholdTokens: Int? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.lastMessage = lastMessage
        self.error = error
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.modelContextWindowTokens = modelContextWindowTokens
        self.contextCompactionThresholdTokens = contextCompactionThresholdTokens
    }
}
