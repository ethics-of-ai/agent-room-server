import Foundation

/// Operator-facing catalog status. Counts and validation metadata are bounded;
/// no catalog asset content crosses this endpoint.
public struct EditorCatalogStatus: Codable, Hashable, Sendable {
    public var enabled: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var schemaVersion: Int?
    public var languageMapVersion: Int?
    public var languageCount: Int
    public var syntaxProviders: EditorCatalogSyntaxProviders
    public var primaryGrammarCount: Int
    public var scopeGrammarCount: Int
    /// Distinct scopes the live grammars include that no grammar supplies; text under
    /// them tokenizes as its enclosing scope. Zero on a backend that predates the count.
    public var unresolvedScopeCount: Int
    public var validation: EditorCatalogValidation

    public init(
        enabled: Bool,
        source: EditorCatalogSource,
        version: String?,
        schemaVersion: Int? = nil,
        languageMapVersion: Int? = nil,
        languageCount: Int,
        syntaxProviders: EditorCatalogSyntaxProviders = .init(),
        primaryGrammarCount: Int = 0,
        scopeGrammarCount: Int = 0,
        unresolvedScopeCount: Int = 0,
        validation: EditorCatalogValidation = .accepted
    ) {
        self.enabled = enabled
        self.source = source
        self.version = version
        self.schemaVersion = schemaVersion
        self.languageMapVersion = languageMapVersion
        self.languageCount = languageCount
        self.syntaxProviders = syntaxProviders
        self.primaryGrammarCount = primaryGrammarCount
        self.scopeGrammarCount = scopeGrammarCount
        self.unresolvedScopeCount = unresolvedScopeCount
        self.validation = validation
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, source, version, schemaVersion, languageMapVersion, languageCount
        case syntaxProviders, primaryGrammarCount, scopeGrammarCount, unresolvedScopeCount, validation
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        source = try container.decode(EditorCatalogSource.self, forKey: .source)
        version = try container.decodeIfPresent(String.self, forKey: .version)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion)
        languageMapVersion = try container.decodeIfPresent(Int.self, forKey: .languageMapVersion)
        languageCount = try container.decode(Int.self, forKey: .languageCount)
        syntaxProviders = try container.decodeIfPresent(EditorCatalogSyntaxProviders.self, forKey: .syntaxProviders) ?? .init()
        primaryGrammarCount = try container.decodeIfPresent(Int.self, forKey: .primaryGrammarCount) ?? 0
        scopeGrammarCount = try container.decodeIfPresent(Int.self, forKey: .scopeGrammarCount) ?? 0
        unresolvedScopeCount = try container.decodeIfPresent(Int.self, forKey: .unresolvedScopeCount) ?? 0
        validation = try container.decodeIfPresent(EditorCatalogValidation.self, forKey: .validation) ?? .accepted
    }
}
