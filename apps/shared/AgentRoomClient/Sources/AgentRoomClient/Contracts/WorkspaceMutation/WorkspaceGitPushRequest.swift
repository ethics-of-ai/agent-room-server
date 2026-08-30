import Foundation

public struct WorkspaceGitPushRequest: Codable, Hashable {
    /// Publish a branch that has no upstream yet (`push --set-upstream`).
    public var setUpstream: Bool?

    public init(setUpstream: Bool? = nil) {
        self.setUpstream = setUpstream
    }
}
