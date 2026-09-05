import Foundation

/// Reviewable origin and license identity for an imported grammar family.
public struct EditorCatalogProvenance: Codable, Hashable, Sendable {
    public var family: String
    public var source: String
    public var version: String
    public var license: String

    public init(family: String, source: String, version: String, license: String) {
        self.family = family
        self.source = source
        self.version = version
        self.license = license
    }
}
