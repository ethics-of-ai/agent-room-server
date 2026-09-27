import Foundation

/// The `cursor` section: the offline fallback model list.
struct CursorModelCatalog: Codable, Equatable {
    var fallbackModels: [CursorCatalogModel]
}
