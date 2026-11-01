import Foundation

/// The answer to Land and Update from parent. `git` is the Git operation
/// result for the workspace that moved: the parent's after a Land
/// (`mergeFastForward`), the child's after an Update (`updateFromParent`).
/// `child` is the child's fresh summary.
public struct ChildThreadGitResponse: Codable, Hashable {
    public var git: WorkspaceGitOperationResult
    public var child: ChildThreadSummary

    public init(git: WorkspaceGitOperationResult, child: ChildThreadSummary) {
        self.git = git
        self.child = child
    }
}
