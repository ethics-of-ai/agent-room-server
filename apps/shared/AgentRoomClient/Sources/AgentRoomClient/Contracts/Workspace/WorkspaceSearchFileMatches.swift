import Foundation

/// Every returned hit in one file. `truncated` is per-file: this file had more
/// matches than were returned, because of the per-file cap, the run's total
/// match cap, or the per-file byte cap.
public struct WorkspaceSearchFileMatches: Codable, Hashable, Identifiable {
    public var path: String
    public var matches: [WorkspaceSearchMatch]
    public var truncated: Bool

    public var id: String { path }

    public init(path: String, matches: [WorkspaceSearchMatch], truncated: Bool) {
        self.path = path
        self.matches = matches
        self.truncated = truncated
    }
}
