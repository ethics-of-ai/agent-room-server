import Foundation

/// Which launch secrets are configured, never what they are.
///
/// It iterates the bundled bootstrap descriptors rather than naming a field per
/// runner, so a runner that registers a slot appears in an exported diagnostic
/// without this type learning its name — and a stored value for a slot no
/// descriptor declares is not reported at all, the same allowlist the launch
/// environment uses.
struct SanitizedSecretStatus: Codable, Equatable {
    var authTokenConfigured: Bool
    /// `runnerKind` → `slotID` → whether a value is stored.
    var runnerSlotsConfigured: [String: [String: Bool]]

    init(
        secrets: BackendSecretValues,
        descriptors: [RunnerBootstrapDescriptor] = RunnerBootstrapCatalog.builtIn
    ) {
        self.authTokenConfigured = secrets.authToken.isConfiguredSecret
        self.runnerSlotsConfigured = descriptors.reduce(into: [:]) { configured, descriptor in
            let slots = descriptor.slots.reduce(into: [String: Bool]()) { slotStatus, slot in
                slotStatus[slot.id] = secrets
                    .slotValue(runnerKind: descriptor.runnerKind, slotID: slot.id)
                    .isConfiguredSecret
            }
            configured[descriptor.runnerKind] = slots
        }
    }
}

private extension Optional where Wrapped == String {
    var isConfiguredSecret: Bool {
        guard let value = self else {
            return false
        }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
