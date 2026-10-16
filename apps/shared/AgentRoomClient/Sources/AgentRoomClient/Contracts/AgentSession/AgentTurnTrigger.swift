import Foundation

/// Why a turn with no user message started. Today the only kind is
/// `background_task`: the agent answered background work that finished.
public struct AgentTurnTrigger: Codable, Hashable, Sendable {
    public var kind: String
    public var tasks: [AgentFinishedBackgroundTask]

    public init(kind: String, tasks: [AgentFinishedBackgroundTask]) {
        self.kind = kind
        self.tasks = tasks
    }
}
