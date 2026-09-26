import Foundation

/// Who authored a sketch transaction. Authorship is server authority — the
/// backend derives it from the calling channel (`human` for REST edits, the
/// runner binding for agent calls) and no client request can carry it.
public struct SketchActorSnapshot: Codable, Hashable {
    public var kind: String
    public var name: String?
    public var runnerId: String?

    public init(kind: String, name: String? = nil, runnerId: String? = nil) {
        self.kind = kind
        self.name = name
        self.runnerId = runnerId
    }
}
