import Foundation

/// A background task that ended, as the agent was told about it.
public struct AgentFinishedBackgroundTask: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var description: String?
    /// `completed`, `failed` or `stopped`.
    public var status: String
    /// The runner's own bounded account of the outcome.
    public var summary: String?

    public init(id: String, description: String? = nil, status: String, summary: String? = nil) {
        self.id = id
        self.description = description
        self.status = status
        self.summary = summary
    }
}
