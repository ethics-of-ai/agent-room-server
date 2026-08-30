import Foundation

public struct AgentBridgeMetrics: Codable, Hashable {
    public var totalSessions: Int
    public var runningSessions: Int
    public var completedTurns: Int
    public var failedTurns: Int
    public var cancelledTurns: Int
    public var inputTokens: Int
    public var outputTokens: Int
    public var totalTokens: Int

    public init(
        totalSessions: Int,
        runningSessions: Int,
        completedTurns: Int,
        failedTurns: Int,
        cancelledTurns: Int,
        inputTokens: Int,
        outputTokens: Int,
        totalTokens: Int
    ) {
        self.totalSessions = totalSessions
        self.runningSessions = runningSessions
        self.completedTurns = completedTurns
        self.failedTurns = failedTurns
        self.cancelledTurns = cancelledTurns
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }
}
