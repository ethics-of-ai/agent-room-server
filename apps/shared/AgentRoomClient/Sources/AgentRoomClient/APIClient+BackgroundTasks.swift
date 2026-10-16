import Foundation

extension APIClient {
    /// Ask the session's runner to stop one listed background task. The task's
    /// end arrives as `agent_background_tasks_changed`. A `404` means the task
    /// is no longer live, or the backend predates background tasks.
    public func stopBackgroundTask(sessionId: String, taskId: String) async throws -> AgentSession {
        let response: AgentSessionResponse = try await request(
            ["api", "agent-sessions", sessionId, "background-tasks", taskId, "stop"],
            method: "POST"
        )
        return response.session
    }
}
