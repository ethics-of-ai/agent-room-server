import Foundation

public struct LocalWorkspace: Codable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var path: String
    public var kind: String
    public var trustedAt: String
    public var lastOpenedAt: String
    public var git: LocalWorkspaceGitSnapshot

    public init(
        id: String,
        name: String,
        path: String,
        kind: String,
        trustedAt: String,
        lastOpenedAt: String,
        git: LocalWorkspaceGitSnapshot
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.kind = kind
        self.trustedAt = trustedAt
        self.lastOpenedAt = lastOpenedAt
        self.git = git
    }
}
