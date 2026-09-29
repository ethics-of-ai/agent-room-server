import Foundation

/// A thread plan's lifecycle status. Open like `CodingCanonicalActivityKind`:
/// a status a newer backend adds decodes as its raw value instead of failing
/// the whole plan read, and a client shows it generically.
public struct ThreadPlanStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let draft = ThreadPlanStatus(rawValue: "draft")
    public static let running = ThreadPlanStatus(rawValue: "running")
    public static let blocked = ThreadPlanStatus(rawValue: "blocked")
    public static let paused = ThreadPlanStatus(rawValue: "paused")
    public static let completed = ThreadPlanStatus(rawValue: "completed")
    public static let cancelled = ThreadPlanStatus(rawValue: "cancelled")

    /// Only `get_plan` or an explicit replacement applies to a terminal plan.
    public var isTerminal: Bool { self == .completed || self == .cancelled }
}
