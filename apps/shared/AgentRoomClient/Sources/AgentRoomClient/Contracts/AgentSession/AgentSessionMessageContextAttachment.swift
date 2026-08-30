import Foundation

public struct AgentSessionMessageContextAttachment: Codable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var sourceName: String
    public var contentType: String
    public var sizeBytes: Int

    public init(
        id: String,
        kind: String,
        sourceName: String,
        contentType: String,
        sizeBytes: Int
    ) {
        self.id = id
        self.kind = kind
        self.sourceName = sourceName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }
}
