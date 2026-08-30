import Foundation

public struct WorkspaceGitPathsRequest: Codable, Hashable {
    public var paths: [String]?
    /// Act on every changed path git reports instead of a caller-supplied list.
    public var all: Bool?

    public init(paths: [String]? = nil, all: Bool? = nil) {
        self.paths = paths
        self.all = all
    }
}
