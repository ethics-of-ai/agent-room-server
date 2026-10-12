import Foundation

/// One sketch in `SketchIndexResponse`.
public struct SketchIndexEntry: Codable, Hashable, Sendable {
    public var path: String
    /// The file name without `.sketch.json`, with `-` and `_` shown as spaces.
    public var title: String
    /// `ok`, or `invalid` for a file that does not read as a sketch.
    public var state: String
    public var sketchId: String?
    public var revision: Int?
    public var objectCount: Int?
    public var lastChangedAt: String?
    /// `human` or `agent`; absent after a change from outside AgentRoom.
    public var lastActorKind: String?
    public var invalidReason: String?

    public init(
        path: String,
        title: String,
        state: String,
        sketchId: String? = nil,
        revision: Int? = nil,
        objectCount: Int? = nil,
        lastChangedAt: String? = nil,
        lastActorKind: String? = nil,
        invalidReason: String? = nil
    ) {
        self.path = path
        self.title = title
        self.state = state
        self.sketchId = sketchId
        self.revision = revision
        self.objectCount = objectCount
        self.lastChangedAt = lastChangedAt
        self.lastActorKind = lastActorKind
        self.invalidReason = invalidReason
    }
}
