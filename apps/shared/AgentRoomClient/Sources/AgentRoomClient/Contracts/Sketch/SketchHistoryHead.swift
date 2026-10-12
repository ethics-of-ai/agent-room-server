import Foundation

/// What the next undo would reverse, or the next redo replay, on a backend
/// that advertises `sketchIndex`. Undo is shared by every actor, so the next
/// undo may reverse an agent's step.
public struct SketchHistoryHead: Codable, Hashable, Sendable {
    public var label: String
    /// Nil when the backend sent an actor kind this client does not know.
    public var actorKind: SketchActorKind?

    private enum CodingKeys: String, CodingKey {
        case label
        case actorKind
    }

    public init(label: String, actorKind: SketchActorKind?) {
        self.label = label
        self.actorKind = actorKind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = try container.decode(String.self, forKey: .label)
        actorKind = try container.decodeIfPresent(String.self, forKey: .actorKind).flatMap(SketchActorKind.init(rawValue:))
    }

    public var isAgent: Bool { actorKind == .agent }
}
