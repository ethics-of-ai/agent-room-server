import Foundation

/// Tracked changes in a child's worktree since its base commit, working tree
/// included. Counts only; the summary names no path.
public struct ChildThreadDiffStat: Codable, Hashable, Sendable {
    public var files: Int
    public var insertions: Int
    public var deletions: Int

    public init(files: Int, insertions: Int, deletions: Int) {
        self.files = files
        self.insertions = insertions
        self.deletions = deletions
    }
}
