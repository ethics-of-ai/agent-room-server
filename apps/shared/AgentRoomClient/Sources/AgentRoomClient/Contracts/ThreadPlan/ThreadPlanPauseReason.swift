import Foundation

/// Why the backend paused a running plan. The backend sets it, never the
/// agent. Open for the same reason as `ThreadPlanStatus`.
public struct ThreadPlanPauseReason: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let turnEnded = ThreadPlanPauseReason(rawValue: "turn_ended")
    public static let turnFailed = ThreadPlanPauseReason(rawValue: "turn_failed")
    public static let turnCancelled = ThreadPlanPauseReason(rawValue: "turn_cancelled")
    public static let backendRestarted = ThreadPlanPauseReason(rawValue: "backend_restarted")
}
