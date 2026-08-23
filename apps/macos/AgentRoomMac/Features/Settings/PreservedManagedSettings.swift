import Foundation

/// The settings-file sections this app cannot address, carried back out on every
/// write: an unregistered runner's namespace, and a field a newer AgentRoom adds
/// to a runner this one knows.
///
/// This is the macOS half of the forward-compatibility rule Phase 4 of
/// `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` introduced and Phase 5 turns
/// into the document's actual shape. Before Phase 4 this app's whole-file
/// preflight declared *any* unrecognized top-level key malformed — so a `runners`
/// section from a newer AgentRoom would not have been ignored, it would have
/// broken settings loading entirely and dropped the operator's trust posture to
/// defaults. Both readers therefore learned the shape a release before either
/// writer produced it.
///
/// Held as `JSONValue` rather than decoded into a struct on purpose: decoding
/// into a shape this app understands is precisely how a shape it does not
/// understand gets dropped.
struct PreservedManagedSettings: Equatable {
    /// Fields inside `global` that no `ManagedBackendSettingKey` addresses.
    var global: [String: JSONValue] = [:]
    /// Per runner id, the fields this app does not address — including every
    /// field of a runner it does not know at all.
    var runners: [String: [String: JSONValue]] = [:]

    var isEmpty: Bool {
        global.isEmpty && runners.isEmpty
    }
}
