import Foundation

/// A runner section of the backend's model catalog. The raw value is the
/// section's key in `models.json`.
enum ModelCatalogRunner: String, CaseIterable, Hashable {
    case codex
    case claudeCode = "claude_code"
    case cursor
    case deepseek

    var displayName: String {
        switch self {
        case .codex: "Codex"
        case .claudeCode: "Claude Code"
        case .cursor: "Cursor"
        case .deepseek: "DeepSeek"
        }
    }

    /// What the section's list is for, since only DeepSeek's is the live list.
    var listSummary: String {
        switch self {
        case .codex:
            "Shown only when the codex CLI cannot report its own models. To get newer models, update the codex CLI rather than adding them here."
        case .claudeCode:
            "Shown only when the claude CLI cannot report its own models. To get newer models, update the claude CLI rather than adding them here."
        case .cursor:
            "Shown only when Cursor cannot report its own models."
        case .deepseek:
            "DeepSeek has no model list of its own, so this is the list the picker always shows."
        }
    }
}
