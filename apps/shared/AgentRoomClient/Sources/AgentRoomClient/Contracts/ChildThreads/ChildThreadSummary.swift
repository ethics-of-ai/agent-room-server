import Foundation

/// What a parent thread sees of one child: bounded and secret-redacted, with
/// no path list and no file content. The Git fields describe the whole
/// worktree from `baseCommit`, which is what a Land would carry.
///
/// A closed child, listed only with `includeClosed`, has `closedAt`,
/// `missing` true, `continuable` false and an empty `baseCommit`; its
/// `branch` is the one its session last ran on and may be empty.
public struct ChildThreadSummary: Codable, Hashable, Identifiable, Sendable {
    public var sessionId: String
    public var title: String
    public var runnerKind: String
    /// The child session's status: `idle`, `running`, `failed` or `cancelled`.
    public var status: String
    /// Set while a turn runs.
    public var activeTurnId: String?
    public var closedAt: String?
    public var workspaceId: String
    public var branch: String
    public var baseCommit: String
    /// Commits on the child's branch past `baseCommit`.
    public var commitsAhead: Int
    /// The worktree has tracked changes or untracked files. Land and Update
    /// refuse with `child_dirty` while this is true.
    public var uncommitted: Bool
    public var untrackedCount: Int
    /// The worktree folder or the child's workspace record is gone. The counts
    /// are then zero. Close still works.
    public var missing: Bool
    /// Whether the child can take another turn.
    public var continuable: Bool
    public var diff: ChildThreadDiffStat
    /// `permission` or `question` while the child's running turn waits on the
    /// person. Absent otherwise.
    public var waitingOn: String?
    public var lastTurn: ChildThreadLastTurn?
    public var updatedAt: String

    public var id: String { sessionId }

    public init(
        sessionId: String,
        title: String,
        runnerKind: String,
        status: String,
        activeTurnId: String? = nil,
        closedAt: String? = nil,
        workspaceId: String,
        branch: String,
        baseCommit: String,
        commitsAhead: Int,
        uncommitted: Bool,
        untrackedCount: Int,
        missing: Bool,
        continuable: Bool,
        diff: ChildThreadDiffStat,
        waitingOn: String? = nil,
        lastTurn: ChildThreadLastTurn? = nil,
        updatedAt: String
    ) {
        self.sessionId = sessionId
        self.title = title
        self.runnerKind = runnerKind
        self.status = status
        self.activeTurnId = activeTurnId
        self.closedAt = closedAt
        self.workspaceId = workspaceId
        self.branch = branch
        self.baseCommit = baseCommit
        self.commitsAhead = commitsAhead
        self.uncommitted = uncommitted
        self.untrackedCount = untrackedCount
        self.missing = missing
        self.continuable = continuable
        self.diff = diff
        self.waitingOn = waitingOn
        self.lastTurn = lastTurn
        self.updatedAt = updatedAt
    }
}
