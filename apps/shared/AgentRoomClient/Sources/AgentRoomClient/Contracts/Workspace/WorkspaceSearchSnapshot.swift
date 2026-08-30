import Foundation

/// Result of a bounded, read-only literal-substring search over a registered
/// workspace. `filesScanned` counts files actually opened and read. The
/// top-level `truncated` is a *global* bound — the index cap, the file-scan cap,
/// the total-match cap, or the time budget cut the run short — and is distinct
/// from each file's own `truncated`.
public struct WorkspaceSearchSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var query: String
    public var files: [WorkspaceSearchFileMatches]
    public var totalMatches: Int
    public var filesScanned: Int
    public var truncated: Bool

    public init(
        workspaceId: String,
        query: String,
        files: [WorkspaceSearchFileMatches],
        totalMatches: Int,
        filesScanned: Int,
        truncated: Bool
    ) {
        self.workspaceId = workspaceId
        self.query = query
        self.files = files
        self.totalMatches = totalMatches
        self.filesScanned = filesScanned
        self.truncated = truncated
    }
}
