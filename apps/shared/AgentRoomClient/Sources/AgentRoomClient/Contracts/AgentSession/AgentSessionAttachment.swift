import Foundation

public struct AgentSessionAttachment: Codable, Hashable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var sessionId: String
    public var kind: String
    public var sourceName: String
    public var contentType: String
    public var sizeBytes: Int
    public var sha256: String
    public var createdAt: String

    public init(
        id: String,
        workspaceId: String,
        sessionId: String,
        kind: String,
        sourceName: String,
        contentType: String,
        sizeBytes: Int,
        sha256: String,
        createdAt: String
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.sessionId = sessionId
        self.kind = kind
        self.sourceName = sourceName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.sha256 = sha256
        self.createdAt = createdAt
    }
}
