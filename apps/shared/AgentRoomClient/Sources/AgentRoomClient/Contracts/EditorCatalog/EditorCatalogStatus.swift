import Foundation

/// Operator-facing catalog status for the macOS catalog pane. Carries no asset
/// content — only the live source + aggregate version + language count.
public struct EditorCatalogStatus: Codable, Hashable, Sendable {
    public var enabled: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var languageCount: Int

    public init(enabled: Bool, source: EditorCatalogSource, version: String?, languageCount: Int) {
        self.enabled = enabled
        self.source = source
        self.version = version
        self.languageCount = languageCount
    }
}
