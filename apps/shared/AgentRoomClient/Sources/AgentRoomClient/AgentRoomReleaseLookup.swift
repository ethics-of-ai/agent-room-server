import Foundation

/// A validated public release plus the freshness of the lookup that returned
/// it. A stale result remains safe to show, but callers must also tell the user
/// that GitHub could not be checked.
public struct AgentRoomReleaseLookup: Equatable, Sendable {
    public var release: AgentRoomRelease
    public var source: Source

    public init(release: AgentRoomRelease, source: Source) {
        self.release = release
        self.source = source
    }

    public enum Source: Equatable, Sendable {
        case network
        case freshCache
        case staleCache
    }
}
