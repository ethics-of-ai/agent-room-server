import Foundation

/// A public GitHub release after its AgentRoom manifest and Mac artifact have
/// been cross-checked.
public struct AgentRoomRelease: Codable, Hashable, Sendable {
    public var tagName: String
    public var releasePageURL: URL
    public var publishedAt: Date?
    public var manifest: AgentRoomReleaseManifest
    public var macDownloadURL: URL
    public var macAssetSizeBytes: Int?
    public var checkedAt: Date

    public init(
        tagName: String,
        releasePageURL: URL,
        publishedAt: Date?,
        manifest: AgentRoomReleaseManifest,
        macDownloadURL: URL,
        macAssetSizeBytes: Int?,
        checkedAt: Date
    ) {
        self.tagName = tagName
        self.releasePageURL = releasePageURL
        self.publishedAt = publishedAt
        self.manifest = manifest
        self.macDownloadURL = macDownloadURL
        self.macAssetSizeBytes = macAssetSizeBytes
        self.checkedAt = checkedAt
    }
}
