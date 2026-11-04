import Foundation

/// An auxiliary TextMate scope used by a primary grammar but not exposed as a
/// standalone editor language.
public struct EditorCatalogScopeGrammar: Codable, Hashable, Sendable {
    public var scopeName: String
    public var grammar: EditorCatalogAssetRef
    public var injectionScopes: [String]?

    public init(
        scopeName: String,
        grammar: EditorCatalogAssetRef,
        injectionScopes: [String]? = nil
    ) {
        self.scopeName = scopeName
        self.grammar = grammar
        self.injectionScopes = injectionScopes
    }
}
