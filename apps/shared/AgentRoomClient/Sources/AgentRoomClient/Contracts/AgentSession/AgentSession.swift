import Foundation

public struct AgentSession: Codable, Hashable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var workspacePath: String
    public var gitBranch: String?
    public var runnerKind: String
    public var settings: CodingAgentTurnSettings?
    public var modelContextWindowTokens: Int?
    public var contextWindowUsedTokens: Int?
    /// Where this session's runner auto-compacts, when it reports a threshold.
    /// Absent means unknown, never "this runner does not compact": only Claude
    /// Code publishes a number, so a reader shows absence rather than a line
    /// the client picked. The backend persists it, so a restored thread carries
    /// the value its last turn read until a new turn refreshes it.
    public var contextCompactionThresholdTokens: Int?
    public var title: String?
    public var status: String
    public var activeTurnId: String?
    public var lastMessage: String?
    public var error: String?
    public var turnCount: Int
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String,
        workspaceId: String,
        workspacePath: String,
        gitBranch: String? = nil,
        runnerKind: String,
        settings: CodingAgentTurnSettings? = nil,
        modelContextWindowTokens: Int? = nil,
        contextWindowUsedTokens: Int? = nil,
        contextCompactionThresholdTokens: Int? = nil,
        title: String?,
        status: String,
        activeTurnId: String?,
        lastMessage: String?,
        error: String?,
        turnCount: Int,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.workspacePath = workspacePath
        self.gitBranch = gitBranch
        self.runnerKind = runnerKind
        self.settings = settings
        self.modelContextWindowTokens = modelContextWindowTokens
        self.contextWindowUsedTokens = contextWindowUsedTokens
        self.contextCompactionThresholdTokens = contextCompactionThresholdTokens
        self.title = title
        self.status = status
        self.activeTurnId = activeTurnId
        self.lastMessage = lastMessage
        self.error = error
        self.turnCount = turnCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
