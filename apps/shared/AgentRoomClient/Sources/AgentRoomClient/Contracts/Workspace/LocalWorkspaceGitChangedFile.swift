import Foundation

public struct LocalWorkspaceGitChangedFile: Codable, Hashable, Identifiable {
    public var path: String
    public var oldPath: String?
    public var status: String
    public var staged: Bool
    public var unstaged: Bool
    public var additions: Int?
    public var deletions: Int?

    public var id: String { "\(path):\(oldPath ?? ""):\(status)" }

    public init(
        path: String,
        oldPath: String? = nil,
        status: String,
        staged: Bool,
        unstaged: Bool,
        additions: Int? = nil,
        deletions: Int? = nil
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.staged = staged
        self.unstaged = unstaged
        self.additions = additions
        self.deletions = deletions
    }
}
