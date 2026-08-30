import Foundation

/// Result of an operator-triggered catalog reload (Phase C.5). `changed` is true
/// only when the aggregate version moved, which is also when the backend broadcasts
/// `editor_catalog_changed` so paired visionOS clients re-hydrate.
public struct EditorCatalogReloadResult: Codable, Hashable, Sendable {
    public var reloaded: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var changed: Bool

    public init(reloaded: Bool, source: EditorCatalogSource, version: String?, changed: Bool) {
        self.reloaded = reloaded
        self.source = source
        self.version = version
        self.changed = changed
    }
}
