import Foundation

/// `models.json`, as the backend's `runner/modelCatalog.ts` reads it. The
/// bundled copy lists every runner. The operator's local copy lists only the
/// runners it replaces.
struct ModelCatalogDocument: Codable, Equatable {
    /// Sections keyed as the backend keys them; an absent one means "use bundled".
    struct Runners: Codable, Equatable {
        var claudeCode: ClaudeCodeModelCatalog?
        var cursor: CursorModelCatalog?
        var deepseek: DeepSeekModelCatalog?

        private enum CodingKeys: String, CodingKey {
            case claudeCode = "claude_code"
            case cursor
            case deepseek
        }

        var isEmpty: Bool {
            claudeCode == nil && cursor == nil && deepseek == nil
        }
    }

    /// The document version this release reads and writes.
    static let currentSchemaVersion = 1

    static let localFileComment = "Written by the AgentRoom Models settings pane. Each runner listed here replaces that runner's bundled model list; runners left out use the bundled list."

    var comment: String?
    var schemaVersion: Int
    var runners: Runners

    private enum CodingKeys: String, CodingKey {
        case comment = "$comment"
        case schemaVersion
        case runners
    }
}
