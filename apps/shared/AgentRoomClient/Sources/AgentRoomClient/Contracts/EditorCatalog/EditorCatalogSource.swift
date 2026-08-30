import Foundation

/// Which directory the backend assembled the live catalog from (Phase C.5):
/// an operator-managed override dir, the shipped bundled dir, or no catalog.
public enum EditorCatalogSource: String, Codable, Hashable, Sendable {
    // `override` is a Swift keyword; the wire value stays "override".
    case overrideDir = "override"
    case bundled
    case none
}
