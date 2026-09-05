import Foundation

/// Swift mirror of the backend's managed settings, held flat by their
/// version-1 keys (`managedSettingKeys` in
/// `apps/backend/src/config/settingsStore.ts`).
///
/// Flat in memory, nested on disk: the settings file is a version-2 document
/// that addresses each setting under the runner that owns it, and
/// `ManagedSettingsDocument` is what converts between the two. Keeping the
/// in-memory model flat is what left every pane in this app unchanged when the
/// document shape moved.
///
/// Every key is optional because an absent key means "use the backend's code
/// default", which is a different statement from any value this app could pick.
/// Values are stored in their JSON-native Swift types rather than as Swift enums:
/// this app edits only a handful of these keys, and the rest must survive a
/// round trip so that a Mac-side toggle never drops what a paired client or a
/// hand edit put in the file.
///
/// Unknown keys and explicit nulls are rejected before decoding. The backend's
/// schema is `.strict()` and its fields are optional rather than nullable, so
/// accepting either here would make the panes show a file the backend drops
/// whole. Resetting the file is the deliberate repair path.
struct ManagedBackendSettings: Codable, Equatable {
    // Global — the backend itself. Tier 1 (preference) except where noted.
    var runnerKind: String?
    var artifactsEnabled: Bool?
    var languageCatalogEnabled: Bool?
    var sceneEngineEnabled: Bool?
    var clarifyingQuestionsEnabled: Bool?
    var gitCommandTimeoutMs: Int?
    var gitNetworkTimeoutMs: Int?
    // Tier 2 — trust posture.
    var languageServicesEnabled: Bool?
    var terminalEnabled: Bool?
    var terminalMaxSessions: Int?
    // Codex.
    var codexModel: String?
    var codexReasoningEffort: String?
    var codexServiceTier: String?
    var codexApprovalPolicy: String?
    var codexSandboxMode: String?
    var codexWorkspaceNetworkAccess: Bool?
    // Claude Code.
    var claudeCodeModel: String?
    var claudeCodeReasoningEffort: String?
    var claudeCodePermissionMode: String?
    var claudeCodeLoadWorkspaceSkills: Bool?
    var claudeCodeInheritProviderAuth: Bool?
    // DeepSeek Harness.
    var deepseekModel: String?
    var deepseekProvider: String?
    var deepseekMaxTokens: Int?
    // Tier 2 — the harness's own approval posture. Its vocabulary belongs to the
    // profile the runtime composes, not to AgentRoom, so this app validates the
    // shape the backend bounds it by and never a list of values it would have to
    // keep in step with a developer preview.
    var deepseekPermissionMode: String?
    // Cursor.
    var cursorModel: String?
    // Open like the DeepSeek provider: each Cursor model declares its own effort
    // vocabulary, so this app validates the shape the backend bounds it by.
    var cursorReasoningEffort: String?
    var cursorServiceTier: String?
    // Tier 2 — the SDK's own posture, three booleans.
    var cursorSandbox: Bool?
    var cursorAutoReview: Bool?
    var cursorLoadWorkspaceSettings: Bool?

    static let codexSandboxModeWorkspaceWrite = "workspace-write"
    static let codexSandboxModeDangerFullAccess = "danger-full-access"
    static let reasoningEffortValues = ["none", "minimal", "low", "medium", "high", "xhigh"]

    /// The backend's own defaults for the keys these panes render, so a control
    /// shows what an absent key actually produces instead of guessing.
    static let defaultRunnerKind = AppSettings.defaultRunnerKind
    static let defaultSceneEngineEnabled = true
    static let defaultLanguageServicesEnabled = false
    static let defaultTerminalEnabled = false
    static let defaultCodexWorkspaceNetworkAccess = false

    /// The runner id in force, which is the backend's own default when the key is
    /// absent. Deliberately a `String`: the set of runner ids is the backend
    /// registry's answer (`GET /api/runners`), and resolving an unrecognized one
    /// to Codex here would misreport the operator's own configuration.
    var resolvedRunnerKind: String {
        runnerKind ?? Self.defaultRunnerKind
    }

    var resolvedSceneEngineEnabled: Bool {
        sceneEngineEnabled ?? Self.defaultSceneEngineEnabled
    }

    var resolvedLanguageServicesEnabled: Bool {
        languageServicesEnabled ?? Self.defaultLanguageServicesEnabled
    }

    var resolvedTerminalEnabled: Bool {
        terminalEnabled ?? Self.defaultTerminalEnabled
    }

    /// The Runner pane's single "Allow fetch, pull, and push" control. It reads
    /// the network key alone; the sandbox mode travels with it (below) because
    /// Codex cannot write `.git` metadata under `workspace-write`.
    var codexGitNetworkAccessEnabled: Bool {
        codexWorkspaceNetworkAccess ?? Self.defaultCodexWorkspaceNetworkAccess
    }

    /// One operator choice, two honest keys. The pane used to express this as a
    /// pair of environment variables computed at launch; the file keeps them
    /// separate so `/api/config` can report each one's real value and provenance.
    mutating func setCodexGitNetworkAccess(_ isEnabled: Bool) {
        codexWorkspaceNetworkAccess = isEnabled
        codexSandboxMode = isEnabled ? Self.codexSandboxModeDangerFullAccess : Self.codexSandboxModeWorkspaceWrite
    }

    /// zod trims model and service-tier ids before validating them. Normalizing
    /// here keeps Swift's in-memory value and the bytes the backend resolves in
    /// agreement rather than merely accepting the same input.
    mutating func normalizeForBackendSchema() {
        codexModel = codexModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        codexServiceTier = codexServiceTier?.trimmingCharacters(in: .whitespacesAndNewlines)
        claudeCodeModel = claudeCodeModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        deepseekModel = deepseekModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        deepseekProvider = deepseekProvider?.trimmingCharacters(in: .whitespacesAndNewlines)
        deepseekPermissionMode = deepseekPermissionMode?.trimmingCharacters(in: .whitespacesAndNewlines)
        cursorModel = cursorModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        cursorReasoningEffort = cursorReasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Returns the first mismatch with `managedSettingsSchema`. The backend
    /// drops an invalid file whole, so the Mac must reject the same file whole
    /// instead of presenting a partially effective trust posture.
    func backendSchemaIssue() -> String? {
        // `runnerKind` is deliberately not checked against a compiled-in list.
        // The backend registry is the authority on membership, and a Mac at the
        // The compatibility floor must be able to preserve a runner id a
        // newer backend registered. JSON decoding above still enforces that the
        // value is a non-null string; the remaining fields have stable value
        // vocabularies this release can validate locally.
        if let codexModel, !Self.isModelIdentifier(codexModel) {
            return Self.issue(for: "codexModel")
        }
        if let codexReasoningEffort, !Self.reasoningEffortValues.contains(codexReasoningEffort) {
            return Self.issue(for: "codexReasoningEffort")
        }
        if let codexServiceTier, !Self.isServiceTierIdentifier(codexServiceTier) {
            return Self.issue(for: "codexServiceTier")
        }
        if let claudeCodeModel, !Self.isModelIdentifier(claudeCodeModel) {
            return Self.issue(for: "claudeCodeModel")
        }
        if let claudeCodeReasoningEffort, !Self.reasoningEffortValues.contains(claudeCodeReasoningEffort) {
            return Self.issue(for: "claudeCodeReasoningEffort")
        }
        if let deepseekModel, !Self.isModelIdentifier(deepseekModel) {
            return Self.issue(for: "deepseekModel")
        }
        if let deepseekProvider, !Self.isServiceTierIdentifier(deepseekProvider) {
            return Self.issue(for: "deepseekProvider")
        }
        if let deepseekPermissionMode, !Self.isServiceTierIdentifier(deepseekPermissionMode) {
            return Self.issue(for: "deepseekPermissionMode")
        }
        if let deepseekMaxTokens, !Self.isBackendInteger(deepseekMaxTokens, minimum: 1) {
            return Self.issue(for: "deepseekMaxTokens")
        }
        if let cursorModel, !Self.isModelIdentifier(cursorModel) {
            return Self.issue(for: "cursorModel")
        }
        if let cursorReasoningEffort, !Self.isServiceTierIdentifier(cursorReasoningEffort) {
            return Self.issue(for: "cursorReasoningEffort")
        }
        if let cursorServiceTier, !Self.cursorServiceTiers.contains(cursorServiceTier) {
            return Self.issue(for: "cursorServiceTier")
        }
        if let gitCommandTimeoutMs, !Self.isBackendInteger(gitCommandTimeoutMs, minimum: 1) {
            return Self.issue(for: "gitCommandTimeoutMs")
        }
        if let gitNetworkTimeoutMs, !Self.isBackendInteger(gitNetworkTimeoutMs, minimum: 1) {
            return Self.issue(for: "gitNetworkTimeoutMs")
        }
        if let terminalMaxSessions, !(1...64).contains(terminalMaxSessions) {
            return Self.issue(for: "terminalMaxSessions")
        }
        if let claudeCodePermissionMode, !Self.claudeCodePermissionModes.contains(claudeCodePermissionMode) {
            return Self.issue(for: "claudeCodePermissionMode")
        }
        if let codexApprovalPolicy, !Self.codexApprovalPolicies.contains(codexApprovalPolicy) {
            return Self.issue(for: "codexApprovalPolicy")
        }
        if let codexSandboxMode, !Self.codexSandboxModes.contains(codexSandboxMode) {
            return Self.issue(for: "codexSandboxMode")
        }
        return nil
    }

    private static let claudeCodePermissionModes = ["default", "acceptEdits", "dontAsk", "bypassPermissions"]
    private static let codexApprovalPolicies = ["untrusted", "on-failure", "on-request", "never"]
    private static let codexSandboxModes = ["read-only", "workspace-write", "danger-full-access"]
    // Mirrors `cursorServiceTierSchema`: the one closed Cursor vocabulary, since
    // every Cursor model that declares speed declares the same boolean `fast`.
    private static let cursorServiceTiers = ["standard", "fast"]
    private static let modelIdentifierCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:[]-"
    )
    private static let serviceTierIdentifierCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"
    )
    // z.number().int() accepts only JavaScript-safe integers.
    private static let maximumBackendInteger = 9_007_199_254_740_991

    private static func isModelIdentifier(_ value: String) -> Bool {
        isIdentifier(value, maxLength: 120, allowed: modelIdentifierCharacters)
    }

    private static func isServiceTierIdentifier(_ value: String) -> Bool {
        isIdentifier(value, maxLength: 80, allowed: serviceTierIdentifierCharacters)
    }

    private static func isIdentifier(_ value: String, maxLength: Int, allowed: CharacterSet) -> Bool {
        !value.isEmpty
            && value.count <= maxLength
            && value.unicodeScalars.allSatisfy(allowed.contains)
    }

    private static func isBackendInteger(_ value: Int, minimum: Int) -> Bool {
        value >= minimum && value <= maximumBackendInteger
    }

    private static func issue(for key: String) -> String {
        "has an unexpected value for \(key)"
    }
}
