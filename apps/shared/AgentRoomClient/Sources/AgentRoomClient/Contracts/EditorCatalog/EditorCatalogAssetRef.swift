import Foundation

// MARK: - Editor language catalog

/// A backend catalog blob referenced by content hash. Large assets (TextMate
/// grammars, the Oniguruma WASM) are fetched from the bounded asset route and
/// verified against `sha256`; small assets are inlined in the manifest instead.
public struct EditorCatalogAssetRef: Codable, Hashable, Sendable {
    public var path: String
    public var sha256: String
    public var bytes: Int

    public init(path: String, sha256: String, bytes: Int) {
        self.path = path
        self.sha256 = sha256
        self.bytes = bytes
    }
}
