import Foundation

/// The backend-served editor language catalog (Phase C). `version` is an aggregate
/// content hash, so it changes iff any asset changes — the client uses it plus the
/// per-asset `sha256` values to fetch only what changed into a content-addressed
/// cache. The inline maps (`languageMap`, `themes`, `textMateThemes`) reproduce the
/// bundled `EditorLanguages.json` / `EditorThemes.json` / `EditorTextMateThemes.json`.
public struct EditorCatalogManifest: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var version: String
    public var languageMap: JSONValue
    public var grammars: [EditorCatalogGrammar]
    public var scopeGrammars: [EditorCatalogScopeGrammar]
    public var themes: JSONValue
    public var textMateThemes: JSONValue
    public var engine: EditorCatalogEngine

    public init(
        schemaVersion: Int = 1,
        version: String,
        languageMap: JSONValue,
        grammars: [EditorCatalogGrammar],
        scopeGrammars: [EditorCatalogScopeGrammar] = [],
        themes: JSONValue,
        textMateThemes: JSONValue,
        engine: EditorCatalogEngine
    ) {
        self.schemaVersion = schemaVersion
        self.version = version
        self.languageMap = languageMap
        self.grammars = grammars
        self.scopeGrammars = scopeGrammars
        self.themes = themes
        self.textMateThemes = textMateThemes
        self.engine = engine
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, version, languageMap, grammars, scopeGrammars, themes, textMateThemes, engine
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        version = try container.decode(String.self, forKey: .version)
        languageMap = try container.decode(JSONValue.self, forKey: .languageMap)
        grammars = try container.decode([EditorCatalogGrammar].self, forKey: .grammars)
        scopeGrammars = try container.decodeIfPresent([EditorCatalogScopeGrammar].self, forKey: .scopeGrammars) ?? []
        themes = try container.decode(JSONValue.self, forKey: .themes)
        textMateThemes = try container.decode(JSONValue.self, forKey: .textMateThemes)
        engine = try container.decode(EditorCatalogEngine.self, forKey: .engine)
    }
}
