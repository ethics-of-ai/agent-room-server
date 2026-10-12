import Foundation

/// `GET /api/workspaces/:workspaceId/sketches`: the backend's index of a
/// workspace's sketches, rescanned on every read. Served only when
/// `/api/config` advertises `sketchIndex: true`.
public struct SketchIndexResponse: Codable, Hashable, Sendable {
    public var sketches: [SketchIndexEntry]
    /// Sketch files the scan saw, which exceeds `sketches.count` past `limit`.
    public var total: Int
    /// The workspace file index was itself truncated, so `total` is a floor.
    public var truncated: Bool
    public var limit: Int

    public init(sketches: [SketchIndexEntry], total: Int, truncated: Bool, limit: Int) {
        self.sketches = sketches
        self.total = total
        self.truncated = truncated
        self.limit = limit
    }
}
