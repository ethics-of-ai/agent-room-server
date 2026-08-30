import Foundation

/// One grammar binding in the served catalog: a Monaco languageId, its TextMate
/// scope, the grammar blob (by reference), and the VS Code language configuration
/// inlined as raw (JSONC) text.
public struct EditorCatalogGrammar: Codable, Hashable, Sendable {
    public var languageId: String
    public var scopeName: String
    public var grammar: EditorCatalogAssetRef
    public var languageConfig: String?

    public init(languageId: String, scopeName: String, grammar: EditorCatalogAssetRef, languageConfig: String? = nil) {
        self.languageId = languageId
        self.scopeName = scopeName
        self.grammar = grammar
        self.languageConfig = languageConfig
    }
}
