import Foundation

/// What opened a turn whose first message the backend wrote with role
/// `system`, read from the message's `origin`. Both apps label those rows from
/// here. A `system` message without a known origin, such as a background-task
/// notice, has none, and no other role has one, whatever its text says.
public enum AgentSessionMessageOrigin: String, Equatable, Sendable {
    /// A child's first turn: the task its parent handed it.
    case parentTask = "parent_task"
    /// A later turn the parent agent sent the child.
    case parentMessage = "parent_message"
    /// A parent turn that reports one or more settled child turns.
    case childReport = "child_report"

    public init?(message: AgentSessionMessage) {
        guard message.role.lowercased() == "system", let origin = message.origin else { return nil }
        self.init(rawValue: origin)
    }

    public var label: String {
        switch self {
        case .parentTask: "Task from parent thread"
        case .parentMessage: "Message from parent thread"
        case .childReport: "Child report"
        }
    }

    public var systemImage: String {
        switch self {
        case .parentTask, .parentMessage: "arrow.triangle.branch"
        case .childReport: "tray.full"
        }
    }
}
