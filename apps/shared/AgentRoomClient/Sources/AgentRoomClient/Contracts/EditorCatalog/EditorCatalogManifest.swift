import Foundation

/// The backend-served editor language catalog (Phase C). `version` is an aggregate
/// content hash, so it changes iff any asset changes — the client uses it plus the
/// per-asset `sha256` values to fetch only what changed into a content-addressed
/// cache. The inline maps (`languageMap`, `themes`, `textMateThemes`) reproduce the
/// bundled `EditorLanguages.json` / `EditorThemes.json` / `EditorTextMateThemes.json`.
public struct EditorCatalogManifest: Codable, Hashable, Sendable {
    public var version: String
    public var languageMap: JSONValue
    public var grammars: [EditorCatalogGrammar]
    public var themes: JSONValue
    public var textMateThemes: JSONValue
    public var engine: EditorCatalogEngine

    public init(
        version: String,
        languageMap: JSONValue,
        grammars: [EditorCatalogGrammar],
        themes: JSONValue,
        textMateThemes: JSONValue,
        engine: EditorCatalogEngine
    ) {
        self.version = version
        self.languageMap = languageMap
        self.grammars = grammars
        self.themes = themes
        self.textMateThemes = textMateThemes
        self.engine = engine
    }
}
