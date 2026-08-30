import Foundation

/// One response shape for every git operation: the refreshed workspace and Git
/// status, so a client re-renders its whole source-control surface from a single
/// reply instead of chasing the mutation with two more reads.
public struct WorkspaceGitOperationResult: Codable, Hashable {
    public var workspaceId: String
    public var operation: WorkspaceGitOperation
    public var workspace: LocalWorkspace
    public var status: LocalWorkspaceGitStatus
    /// Paths the operation acted on, after filtering.
    public var paths: [String]?
    /// Paths a stage-all enumeration refused because a segment is secret-named
    /// or generated. Surfaced so the UI can say what it skipped.
    public var skippedPaths: [String]?
    public var commit: String?
    public var commitSubject: String?
    public var branch: String?
    public var previousBranch: String?
    public var remote: String?

    public init(
        workspaceId: String,
        operation: WorkspaceGitOperation,
        workspace: LocalWorkspace,
        status: LocalWorkspaceGitStatus,
        paths: [String]? = nil,
        skippedPaths: [String]? = nil,
        commit: String? = nil,
        commitSubject: String? = nil,
        branch: String? = nil,
        previousBranch: String? = nil,
        remote: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.operation = operation
        self.workspace = workspace
        self.status = status
        self.paths = paths
        self.skippedPaths = skippedPaths
        self.commit = commit
        self.commitSubject = commitSubject
        self.branch = branch
        self.previousBranch = previousBranch
        self.remote = remote
    }
}
