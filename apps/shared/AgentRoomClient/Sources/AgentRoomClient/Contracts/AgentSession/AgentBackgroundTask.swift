import Foundation

/// Work the session's agent runs beside its turns, such as a background
/// subagent or shell command. It can outlive the turn that started it. The
/// backend holds the live list in memory, so a reconnect reads it from the
/// session again.
public struct AgentBackgroundTask: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// `agent`, `shell` or `other`; an open vocabulary, so unknown values render generically.
    public var kind: String
    public var description: String
    /// The runner's latest one-line status, when it reports one.
    public var progress: String?
    /// The listed task that launched this one.
    public var parentId: String?
    public var startedAt: String

    public init(id: String, kind: String, description: String, progress: String? = nil, parentId: String? = nil, startedAt: String) {
        self.id = id
        self.kind = kind
        self.description = description
        self.progress = progress
        self.parentId = parentId
        self.startedAt = startedAt
    }
}
