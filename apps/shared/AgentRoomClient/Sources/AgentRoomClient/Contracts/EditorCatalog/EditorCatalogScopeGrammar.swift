import Foundation

/// An auxiliary TextMate scope used by a primary grammar but not exposed as a
/// standalone editor language.
public struct EditorCatalogScopeGrammar: Codable, Hashable, Sendable {
    public var scopeName: String
    public var grammar: EditorCatalogAssetRef
    public var injectionScopes: [String]?
    /// Catalog scopes this grammar reaches through its own `include` rules (schema 2).
    public var dependencyScopes: [String]?
    public var provenance: EditorCatalogProvenance?

    public init(
        scopeName: String,
        grammar: EditorCatalogAssetRef,
        injectionScopes: [String]? = nil,
        dependencyScopes: [String]? = nil,
        provenance: EditorCatalogProvenance? = nil
    ) {
        self.scopeName = scopeName
        self.grammar = grammar
        self.injectionScopes = injectionScopes
        self.dependencyScopes = dependencyScopes
        self.provenance = provenance
    }
}
