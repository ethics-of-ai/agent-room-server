import Foundation

/// The runner kinds this app knows *bespoke presentation* for — a buddy asset, a
/// badge, a model-suggestion field. The wire representation stays a plain
/// `String` on the DTOs.
///
/// It is deliberately **not** `CaseIterable`, and that is the Phase 4 rule of
/// `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` made structural: which runners
/// exist is `RunnerCatalog`'s answer, hydrated from `GET /api/runners`, so a
/// runner the backend registers is offered without shipping the apps again. An
/// `allCases` picker here would silently re-close that list, so the conformance
/// is withheld rather than merely discouraged — the compiler is the enforcement.
///
/// Matching on a case is still correct for presentation that genuinely differs
/// per runner; it must never be how a client decides what a runner *is*.
public enum AgentRunnerKind: String, Codable, Hashable, Sendable {
    case codex
    case claudeCode = "claude_code"
    case deepseek
    case cursor

    /// Human-readable label for pickers and menus.
    public var displayName: String {
        switch self {
        case .codex:
            return "Codex"
        case .claudeCode:
            return "Claude Code"
        case .deepseek:
            return "DeepSeek Harness"
        case .cursor:
            return "Cursor"
        }
    }

    /// Resolve a backend-provided runner-kind string, tolerating unknown values.
    public init?(wireValue: String) {
        self.init(rawValue: wireValue)
    }
}
