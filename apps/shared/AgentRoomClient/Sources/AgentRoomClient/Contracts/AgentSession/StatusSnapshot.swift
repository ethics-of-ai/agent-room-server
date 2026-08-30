import Foundation

public struct StatusSnapshot: Codable, Hashable {
    public var runnerKind: String
    public var uptimeSeconds: Int
    public var sessions: [AgentSession]
    public var activeSessionIds: [String]
    public var recentEvents: [AgentRoomEvent]
    public var metrics: AgentBridgeMetrics

    public init(
        runnerKind: String,
        uptimeSeconds: Int,
        sessions: [AgentSession],
        activeSessionIds: [String],
        recentEvents: [AgentRoomEvent],
        metrics: AgentBridgeMetrics
    ) {
        self.runnerKind = runnerKind
        self.uptimeSeconds = uptimeSeconds
        self.sessions = sessions
        self.activeSessionIds = activeSessionIds
        self.recentEvents = recentEvents
        self.metrics = metrics
    }
}
