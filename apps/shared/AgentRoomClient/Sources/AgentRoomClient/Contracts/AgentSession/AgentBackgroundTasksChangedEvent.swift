import Foundation

/// `agent_background_tasks_changed`: a session's full live background task
/// list after a change. Replace the session's list with it; never merge. The
/// event is live only, so after a reconnect the session read is authoritative.
public struct AgentBackgroundTasksChangedEvent: Hashable, Sendable {
    public static let eventType = "agent_background_tasks_changed"

    public var sessionId: String
    public var workspaceId: String
    public var tasks: [AgentBackgroundTask]

    public init(sessionId: String, workspaceId: String, tasks: [AgentBackgroundTask]) {
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.tasks = tasks
    }

    /// The typed payload, or nil for another event type or a malformed payload.
    public init?(event: AgentRoomEvent) {
        guard event.type == Self.eventType,
              let object = event.payload.objectValue,
              let sessionId = object["sessionId"]?.stringValue,
              let workspaceId = object["workspaceId"]?.stringValue,
              let tasksValue = object["tasks"],
              let data = try? JSONEncoder().encode(tasksValue),
              let tasks = try? JSONDecoder().decode([AgentBackgroundTask].self, from: data) else {
            return nil
        }
        self.init(sessionId: sessionId, workspaceId: workspaceId, tasks: tasks)
    }
}
