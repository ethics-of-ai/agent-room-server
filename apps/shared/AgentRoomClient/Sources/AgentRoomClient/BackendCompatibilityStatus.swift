import Foundation

public enum BackendCompatibilityStatus: String, Hashable, Sendable {
    case compatible
    case backendUpdateRequired
    case clientUpdateRequired
    case unverifiedLegacyBackend
    case invalidMetadata

    public var isKnownIncompatible: Bool {
        self == .backendUpdateRequired || self == .clientUpdateRequired
    }
}
