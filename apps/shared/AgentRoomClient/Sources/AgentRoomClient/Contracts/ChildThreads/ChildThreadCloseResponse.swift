import Foundation

/// The answer to Close.
public struct ChildThreadCloseResponse: Codable, Hashable, Sendable {
    /// True when `git branch -d` kept the child's branch because the parent
    /// checkout's HEAD does not contain it. The commits stay in the parent
    /// repository; this is not an error.
    public var branchKept: Bool

    public init(branchKept: Bool) {
        self.branchKept = branchKept
    }
}
