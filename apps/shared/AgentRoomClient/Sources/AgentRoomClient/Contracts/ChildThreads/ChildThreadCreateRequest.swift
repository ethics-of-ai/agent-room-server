import Foundation

/// The body of `POST /api/agent-sessions/:sessionId/children`. The title is 1
/// to 120 characters and the task 1 to 16 KiB of UTF-8. A nil `runnerKind`
/// uses the parent's runner. Nil `settings` gives the child the parent's
/// settings on the parent's runner, and the runner's defaults on another.
public struct ChildThreadCreateRequest: Codable, Hashable, Sendable {
    public var title: String
    public var task: String
    public var runnerKind: String?
    public var settings: CodingAgentTurnSettings?

    public init(title: String, task: String, runnerKind: String? = nil, settings: CodingAgentTurnSettings? = nil) {
        self.title = title
        self.task = task
        self.runnerKind = runnerKind
        self.settings = settings
    }
}
