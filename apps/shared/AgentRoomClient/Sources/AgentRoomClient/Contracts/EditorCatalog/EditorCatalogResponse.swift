import Foundation

public struct EditorCatalogResponse: Codable, Hashable {
    public var catalog: EditorCatalogManifest

    public init(catalog: EditorCatalogManifest) {
        self.catalog = catalog
    }
}
