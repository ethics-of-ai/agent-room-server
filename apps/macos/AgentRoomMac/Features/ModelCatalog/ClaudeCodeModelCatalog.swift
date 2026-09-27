import Foundation

/// The `claude_code` section: the effort vocabulary and the fallback model list.
struct ClaudeCodeModelCatalog: Codable, Equatable {
    var reasoningEfforts: [ModelCatalogEffortLevel]
    var fallbackModels: [ClaudeCodeCatalogModel]
}
