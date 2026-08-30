import Foundation

/// Only the fields that can reach an activity block. Plan and diff payloads
/// carry their canonical detail on the event itself (`plan`, `files`) and never
/// arrive with an activity, so repeating those here would be dead weight.
public struct CodingCanonicalActivity: Codable, Hashable, Sendable {
    public var kind: CodingCanonicalActivityKind
    /// Stable per-tool-call id, the same value on start, output, and completion.
    public var toolId: String?
    public var delta: String?

    public init(kind: CodingCanonicalActivityKind, toolId: String? = nil, delta: String? = nil) {
        self.kind = kind
        self.toolId = toolId
        self.delta = delta
    }
}
