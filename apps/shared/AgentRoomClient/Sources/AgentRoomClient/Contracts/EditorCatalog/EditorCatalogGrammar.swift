import Foundation

/// One grammar binding in the served catalog: a Monaco languageId, its TextMate
/// scope, the grammar blob (by reference), and the VS Code language configuration
/// inlined as raw (JSONC) text.
public struct EditorCatalogGrammar: Codable, Hashable, Sendable {
    public var languageId: String
    public var scopeName: String
    public var grammar: EditorCatalogAssetRef
    public var languageConfig: String?
    public var embeddedLanguages: [String: String]?
    public var injectionScopes: [String]?
    /// Catalog scopes this grammar reaches through its own `include` rules, derived by
    /// the backend at assembly (schema 2). A client can load a language's closure from it.
    public var dependencyScopes: [String]?
    public var provenance: EditorCatalogProvenance?

    public init(
        languageId: String,
        scopeName: String,
        grammar: EditorCatalogAssetRef,
        languageConfig: String? = nil,
        embeddedLanguages: [String: String]? = nil,
        injectionScopes: [String]? = nil,
        dependencyScopes: [String]? = nil,
        provenance: EditorCatalogProvenance? = nil
    ) {
        self.languageId = languageId
        self.scopeName = scopeName
        self.grammar = grammar
        self.languageConfig = languageConfig
        self.embeddedLanguages = embeddedLanguages
        self.injectionScopes = injectionScopes
        self.dependencyScopes = dependencyScopes
        self.provenance = provenance
    }
}
