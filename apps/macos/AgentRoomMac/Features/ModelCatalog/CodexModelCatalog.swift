import Foundation

/// The `codex` section: the list shown when Codex cannot report its own models.
struct CodexModelCatalog: Codable, Equatable {
    var fallbackModels: [CodexCatalogModel]
}
