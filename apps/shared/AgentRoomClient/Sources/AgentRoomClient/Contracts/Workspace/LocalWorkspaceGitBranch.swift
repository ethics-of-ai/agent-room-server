import Foundation

public struct LocalWorkspaceGitBranch: Codable, Hashable, Identifiable {
    public var name: String
    public var current: Bool
    public var upstream: String?
    public var upstreamGone: Bool?
    public var ahead: Int?
    public var behind: Int?

    public var id: String { name }

    public init(
        name: String,
        current: Bool,
        upstream: String? = nil,
        upstreamGone: Bool? = nil,
        ahead: Int? = nil,
        behind: Int? = nil
    ) {
        self.name = name
        self.current = current
        self.upstream = upstream
        self.upstreamGone = upstreamGone
        self.ahead = ahead
        self.behind = behind
    }
}
