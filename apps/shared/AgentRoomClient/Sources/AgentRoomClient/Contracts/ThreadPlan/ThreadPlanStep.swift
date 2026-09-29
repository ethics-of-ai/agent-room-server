import Foundation

public struct ThreadPlanStep: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var description: String
    public var status: ThreadPlanStepStatus
    /// The agent's report when it completed or skipped the step.
    public var outcome: String?
    /// The latest reason the step blocked. Kept after execution resumes.
    public var lastBlocker: String?

    public init(
        id: String,
        description: String,
        status: ThreadPlanStepStatus,
        outcome: String? = nil,
        lastBlocker: String? = nil
    ) {
        self.id = id
        self.description = description
        self.status = status
        self.outcome = outcome
        self.lastBlocker = lastBlocker
    }
}
