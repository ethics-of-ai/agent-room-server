import Foundation

public struct CreateAgentSessionRequest: Codable, Hashable {
    public var workspaceId: String
    /// Optional runner kind. When `nil` the field is omitted from the request so
    /// the backend applies its configured default (`RUNNER_KIND`).
    public var runnerKind: String?
    public var gitBranch: String?
    public var settings: CodingAgentTurnSettings?
    public var title: String?

    public init(
        workspaceId: String,
        runnerKind: String? = nil,
        gitBranch: String? = nil,
        settings: CodingAgentTurnSettings? = nil,
        title: String?
    ) {
        self.workspaceId = workspaceId
        self.runnerKind = runnerKind
        self.gitBranch = gitBranch
        self.settings = settings
        self.title = title
    }
}
