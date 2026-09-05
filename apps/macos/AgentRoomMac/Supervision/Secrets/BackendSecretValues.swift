import Foundation

/// The launch secrets this app holds for the backend: AgentRoom's own bearer
/// token, plus one value per runner bootstrap slot.
///
/// `docs/engineering/RUNNERS.md` replaces the typed
/// per-runner fields (`codexExecutable`, `codexArgs`, `claudeCodeExecutable`)
/// with a dictionary keyed by runner id and slot id, so a runner that reuses an
/// existing slot kind costs a bundled descriptor rather than three more fields
/// spread through the pane, the diagnostics, and the launch assembly.
///
/// `authToken` stays a named field on purpose: it is AgentRoom's own transport
/// secret rather than any runner's bootstrap, and it is the one value that is
/// never handed to a spawned child.
struct BackendSecretValues: Equatable, Codable {
    var authToken: String?
    /// `runnerKind` → `slotID` → value. Unknown runners and slots are preserved
    /// but never injected: the bundled descriptors are the allowlist, so a value
    /// this build cannot describe survives an upgrade without reaching a child.
    var runnerSlots: [String: [String: String]]
    /// Decode-only compatibility for installs that stored this managed
    /// preference in Keychain before settings.json existed. The supervisor
    /// migrates a valid value into the managed file and clears this field; it is
    /// never injected into a new backend process.
    var legacyCodexReasoningEffort: String?

    static let empty = BackendSecretValues()

    init(
        authToken: String? = nil,
        runnerSlots: [String: [String: String]] = [:],
        legacyCodexReasoningEffort: String? = nil
    ) {
        self.authToken = authToken
        self.runnerSlots = runnerSlots
        self.legacyCodexReasoningEffort = legacyCodexReasoningEffort
    }

    func slotValue(runnerKind: String, slotID: String) -> String? {
        runnerSlots[runnerKind]?[slotID]
    }

    /// Stores a slot value, dropping the entry when the value is blank so an
    /// emptied field does not leave `""` behind to be injected as an override.
    mutating func setSlotValue(_ value: String?, runnerKind: String, slotID: String) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var slots = runnerSlots[runnerKind] ?? [:]
        if trimmed.isEmpty {
            slots.removeValue(forKey: slotID)
        } else {
            slots[slotID] = trimmed
        }
        if slots.isEmpty {
            runnerSlots.removeValue(forKey: runnerKind)
        } else {
            runnerSlots[runnerKind] = slots
        }
    }

    /// The environment the backend is launched with, built by walking the
    /// **bundled descriptors** rather than the stored values. That direction is
    /// the allowlist: a slot no descriptor declares cannot name an environment
    /// variable, so it cannot reach the child.
    func environment(descriptors: [RunnerBootstrapDescriptor] = RunnerBootstrapCatalog.builtIn) -> [String: String] {
        var values: [String: String] = [:]
        if let token = authToken?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            values["AUTH_TOKEN"] = token
        }
        for descriptor in descriptors {
            for slot in descriptor.slots {
                guard let value = slotValue(runnerKind: descriptor.runnerKind, slotID: slot.id)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                      !value.isEmpty else {
                    continue
                }
                values[slot.environmentName] = value
            }
        }
        return values
    }

    /// Every name this app owns in the backend's environment. Stripped from the
    /// inherited environment before launch, so a stale export cannot shadow a
    /// Keychain-held value.
    static var managedEnvironmentNames: [String] {
        ["AUTH_TOKEN"] + RunnerBootstrapCatalog.environmentNames + [legacyReasoningEffortEnvironmentName]
    }

    private static let legacyReasoningEffortEnvironmentName = "CODEX_REASONING_EFFORT"

    // MARK: - Persistence

    /// The blob is one Keychain item shared across app versions, so decoding
    /// accepts the legacy flat shape and folds it into slots. Encoding emits
    /// only the current shape: the legacy keys disappear on the next save, and a
    /// value already migrated is never resurrected by a second read.
    private enum CodingKeys: String, CodingKey {
        case authToken
        case runnerSlots
        case codexExecutable
        case codexArgs
        case codexReasoningEffort
        case claudeCodeExecutable
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        authToken = try container.decodeIfPresent(String.self, forKey: .authToken)
        runnerSlots = try container.decodeIfPresent([String: [String: String]].self, forKey: .runnerSlots) ?? [:]
        legacyCodexReasoningEffort = try container.decodeIfPresent(String.self, forKey: .codexReasoningEffort)

        // A stored slot wins: the flat keys are what an older build wrote, and a
        // newer one has been authoritative since the first save after upgrade.
        migrate(try container.decodeIfPresent(String.self, forKey: .codexExecutable), to: "codex", "executable")
        migrate(try container.decodeIfPresent(String.self, forKey: .codexArgs), to: "codex", "arguments")
        migrate(
            try container.decodeIfPresent(String.self, forKey: .claudeCodeExecutable),
            to: "claude_code",
            "executable"
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(authToken, forKey: .authToken)
        try container.encode(runnerSlots, forKey: .runnerSlots)
        try container.encodeIfPresent(legacyCodexReasoningEffort, forKey: .codexReasoningEffort)
    }

    private mutating func migrate(_ legacyValue: String?, to runnerKind: String, _ slotID: String) {
        guard slotValue(runnerKind: runnerKind, slotID: slotID) == nil else { return }
        setSlotValue(legacyValue, runnerKind: runnerKind, slotID: slotID)
    }
}
