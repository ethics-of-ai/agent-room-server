import Foundation

/// A ranked, bounded slice of a registered workspace's file index. `query`
/// echoes the trimmed query the ranking used, and is empty when the listing was
/// unfiltered. `truncated` is true when the enumeration hit its path cap or when
/// more ranked matches existed than the requested limit.
public struct WorkspaceFileIndexSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var query: String
    public var files: [WorkspaceFileIndexEntry]
    public var truncated: Bool

    public init(
        workspaceId: String,
        query: String,
        files: [WorkspaceFileIndexEntry],
        truncated: Bool
    ) {
        self.workspaceId = workspaceId
        self.query = query
        self.files = files
        self.truncated = truncated
    }
}
