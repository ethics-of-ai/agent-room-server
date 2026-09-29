import Foundation

/// A thread's plan as `GET /api/agent-sessions/:id/plan` returns it. The
/// objective, steps, notes, and summary are model-authored task data. The
/// backend owns every bound and transition; clients only read the plan and
/// have no way to change it.
public struct ThreadPlan: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// Orders snapshots of this plan id only. A replacement plan starts again
    /// at 1, so compare revisions only after comparing ids.
    public var revision: Int
    public var objective: String
    public var completionCriteria: String
    public var steps: [ThreadPlanStep]
    public var status: ThreadPlanStatus
    public var createdAt: String
    public var updatedAt: String
    public var lastModifiedTurnId: String?
    /// The turn executing the plan while it is running or blocked.
    public var executionTurnId: String?
    public var pauseReason: ThreadPlanPauseReason?
    public var resumeNote: String?
    /// The agent's closing summary once the plan is completed or cancelled.
    public var summary: String?

    public init(
        id: String,
        revision: Int,
        objective: String,
        completionCriteria: String,
        steps: [ThreadPlanStep],
        status: ThreadPlanStatus,
        createdAt: String,
        updatedAt: String,
        lastModifiedTurnId: String? = nil,
        executionTurnId: String? = nil,
        pauseReason: ThreadPlanPauseReason? = nil,
        resumeNote: String? = nil,
        summary: String? = nil
    ) {
        self.id = id
        self.revision = revision
        self.objective = objective
        self.completionCriteria = completionCriteria
        self.steps = steps
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastModifiedTurnId = lastModifiedTurnId
        self.executionTurnId = executionTurnId
        self.pauseReason = pauseReason
        self.resumeNote = resumeNote
        self.summary = summary
    }

    /// The first unresolved step's position, or nil when every step is resolved.
    public var currentStepIndex: Int? {
        steps.firstIndex { !$0.status.isResolved }
    }

    /// The first unresolved step, or nil when every step is resolved.
    public var currentStep: ThreadPlanStep? {
        currentStepIndex.map { steps[$0] }
    }
}
