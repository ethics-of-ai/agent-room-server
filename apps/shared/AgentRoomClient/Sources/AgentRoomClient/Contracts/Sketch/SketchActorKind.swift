import Foundation

/// Who made a sketch change: the person, or an agent through the sketch tools.
public enum SketchActorKind: String, Codable, Hashable, Sendable {
    case human
    case agent
}
