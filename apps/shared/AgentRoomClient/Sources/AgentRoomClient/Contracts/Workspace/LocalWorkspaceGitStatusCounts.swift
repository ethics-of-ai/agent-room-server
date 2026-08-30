import Foundation

public struct LocalWorkspaceGitStatusCounts: Codable, Hashable {
    public var total: Int
    public var staged: Int
    public var unstaged: Int
    public var untracked: Int
    public var conflicts: Int

    public init(total: Int, staged: Int, unstaged: Int, untracked: Int, conflicts: Int) {
        self.total = total
        self.staged = staged
        self.unstaged = unstaged
        self.untracked = untracked
        self.conflicts = conflicts
    }
}
