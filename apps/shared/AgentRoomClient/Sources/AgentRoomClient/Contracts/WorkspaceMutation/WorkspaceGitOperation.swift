import Foundation

/// The fixed set of mutating git operations the backend exposes. Nothing here
/// rewrites history: there is no amend, reset, rebase, or forced push, and pull
/// is fast-forward only. See docs/safety/TRUST_AND_SAFETY.md.
public enum WorkspaceGitOperation: String, Codable, Hashable, Sendable {
    case stage
    case unstage
    case discard
    case commit
    case fetch
    case pull
    case push
    case createBranch = "create_branch"
    case switchBranch = "switch_branch"
}
