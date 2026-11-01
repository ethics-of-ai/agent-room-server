import Foundation

/// Why a turn started with no message from the person. `kind` is
/// `background_task` when the agent answered background work that finished,
/// `parent_task` on a child turn its parent started, and `child_report` on a
/// parent turn that reports settled child turns. Every kind carries `tasks`,
/// which is empty outside `background_task`.
public struct AgentTurnTrigger: Codable, Hashable, Sendable {
    public var kind: String
    public var tasks: [AgentFinishedBackgroundTask]
    /// Set on `parent_task`: the thread that started this child turn.
    public var parentSessionId: String?
    /// Set on `child_report`: the child turns this wake reports.
    public var reports: [AgentTurnChildReport]?

    public init(
        kind: String,
        tasks: [AgentFinishedBackgroundTask],
        parentSessionId: String? = nil,
        reports: [AgentTurnChildReport]? = nil
    ) {
        self.kind = kind
        self.tasks = tasks
        self.parentSessionId = parentSessionId
        self.reports = reports
    }
}
