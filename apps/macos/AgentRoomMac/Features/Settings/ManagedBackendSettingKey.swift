import Foundation

/// The backend's *managed* setting names — the settings that live in
/// `$AGENTROOM_HOME/config/settings.json` and appear in `/api/config`'s
/// `settings` metadata block.
///
/// Declaration order and spelling mirror `managedSettingKeys` in
/// `apps/backend/src/config/settingsStore.ts`, and every `path` mirrors the same
/// setting's canonical version-2 address there; a backend test asserts both, so
/// drift fails the build rather than silently producing a pane control that
/// writes a setting the backend ignores.
///
/// Grouped the way the settings file now is: the globals the backend owns, then
/// one block per runner. That grouping is not cosmetic — it is the document
/// shape, and this app has to know it because it edits the file **while the
/// backend is stopped**, which is exactly when it cannot ask.
///
/// Tier 3 (`AUTH_TOKEN`, executable paths, `TERMINAL_SHELL`, host/port, the
/// storage directories) is deliberately absent: those must exist before the
/// process starts, so they stay in Keychain and the launch environment.
enum ManagedBackendSettingKey: String, CaseIterable {
    // Global — the backend itself. Tier 1 (preference) except where noted.
    case runnerKind
    case artifactsEnabled
    case languageCatalogEnabled
    case sceneEngineEnabled
    case clarifyingQuestionsEnabled
    case gitCommandTimeoutMs
    case gitNetworkTimeoutMs
    // Tier 2 — trust posture. Editable from these panes always; editable from a
    // paired client only while the Mac-side `REMOTE_SETTINGS_ADMIN` switch is on.
    case terminalEnabled
    case terminalMaxSessions
    // Codex.
    case codexModel
    case codexReasoningEffort
    case codexServiceTier
    case codexApprovalPolicy
    case codexSandboxMode
    case codexWorkspaceNetworkAccess
    // Claude Code.
    case claudeCodeModel
    case claudeCodeReasoningEffort
    case claudeCodePermissionMode
    case claudeCodeLoadWorkspaceSkills
    case claudeCodeInheritProviderAuth
    // DeepSeek Harness.
    case deepseekModel
    case deepseekProvider
    case deepseekMaxTokens
    // Tier 2 — the harness's own approval posture, whose vocabulary belongs to
    // the composed profile rather than to AgentRoom, so it carries no options.
    case deepseekPermissionMode
}

extension ManagedBackendSettingKey {
    /// The runner id each flat key prefix belongs to — this app's mirror of the
    /// backend descriptors' `settingsKeyPrefix` and id.
    ///
    /// It is the one piece of runner identity the Mac genuinely needs: a
    /// version-2 document addresses a setting under the runner that owns it, and
    /// the panes write that document with the backend stopped. A runner this app
    /// does not know still round-trips — its whole namespace is preserved
    /// verbatim (see `PreservedManagedSettings`) rather than being addressed.
    static let runnerNamespaces: [(prefix: String, runnerKind: String)] = [
        ("codex", "codex"),
        ("claudeCode", "claude_code"),
        ("deepseek", "deepseek")
    ]

    /// The two sections of the settings document. Declared beside the settings
    /// they address, so the document coder spells neither of them itself.
    static let globalSection = "global"
    static let runnersSection = "runners"

    /// The canonical version-2 address: `global.<field>` or
    /// `runners.<runnerKind>.<field>`. Also the key `PATCH /api/config` prefers,
    /// though the backend accepts the flat `rawValue` for the compatibility
    /// window.
    var path: String {
        guard let scope = Self.runnerScope(forKey: rawValue) else {
            return "\(Self.globalSection).\(rawValue)"
        }
        return "\(Self.runnersSection).\(scope.runnerKind).\(scope.field)"
    }

    /// Which runner owns a flat key, and under what field name — `nil` for a
    /// global. The boundary must be a case change, so a key that merely starts
    /// with a runner's prefix (`codexish`) belongs to nobody.
    static func runnerScope(forKey key: String) -> (runnerKind: String, field: String)? {
        for namespace in runnerNamespaces where key.hasPrefix(namespace.prefix) {
            let field = String(key.dropFirst(namespace.prefix.count))
            guard let first = field.first, first.isUppercase else { continue }
            return (namespace.runnerKind, first.lowercased() + field.dropFirst())
        }
        return nil
    }
}
