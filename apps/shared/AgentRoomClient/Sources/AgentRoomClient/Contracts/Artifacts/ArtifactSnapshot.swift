import Foundation

public struct ArtifactSnapshot: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var turnId: String
    public var kind: String
    public var title: String?
    public var content: String
    public var version: Int
    public var isOpen: Bool
    public var truncated: Bool
    public var updatedAt: String

    public init(
        id: String,
        sessionId: String,
        turnId: String,
        kind: String,
        title: String? = nil,
        content: String,
        version: Int,
        isOpen: Bool,
        truncated: Bool,
        updatedAt: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.kind = kind
        self.title = title
        self.content = content
        self.version = version
        self.isOpen = isOpen
        self.truncated = truncated
        self.updatedAt = updatedAt
    }
}
