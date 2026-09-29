import Foundation

/// One step's status. Open for the same reason as `ThreadPlanStatus`.
public struct ThreadPlanStepStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let pending = ThreadPlanStepStatus(rawValue: "pending")
    public static let inProgress = ThreadPlanStepStatus(rawValue: "in_progress")
    public static let blocked = ThreadPlanStepStatus(rawValue: "blocked")
    public static let completed = ThreadPlanStepStatus(rawValue: "completed")
    public static let skipped = ThreadPlanStepStatus(rawValue: "skipped")

    /// Completed and skipped steps form the plan's resolved prefix.
    public var isResolved: Bool { self == .completed || self == .skipped }
}
