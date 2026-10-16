import Foundation

/// One question this app can answer about a runner's local prerequisites with
/// the backend **stopped** — which is exactly when an operator is fixing why it
/// would not start, and exactly why this authority cannot be the backend's.
struct RunnerBootstrapProbe: Equatable, Identifiable {
    /// The closed set of probe kinds. Adding a runner that reuses one costs a
    /// descriptor; a genuinely new primitive costs scoped Swift and a safety
    /// review, which is the honest half of the plan's "no more Swift" claim.
    enum Kind: Equatable {
        /// Resolve a binary for a slot, saving what it finds so the backend
        /// launches with it.
        case executablePath(slotID: String, search: ExecutableSearch)
        /// Validate and normalize an operator-supplied data-file path. Unlike
        /// an executable probe it searches nowhere: which file to trust is the
        /// operator's decision, and the check only proves the saved answer is
        /// absolute, readable, and present.
        case filePath(slotID: String)
        /// Check a Node SDK entrypoint without starting the backend or runtime.
        /// With a `package`, the entrypoint must also come from that package
        /// at a version no older than the tested one, built after its sources.
        case nodeEntrypoint(
            executableSlotID: String,
            argumentsSlotID: String,
            package: RunnerBootstrapEntrypointPackage? = nil
        )
        /// Presence-only Keychain lookup. It requests no item data and never
        /// reads, returns, or logs the credential — see
        /// `docs/safety/TRUST_AND_SAFETY.md`.
        case keychainPresence(service: String)
        /// Presence-only check that a file exists, the file analog of
        /// `keychainPresence` and under the same rule: it stats the path and
        /// never opens, reads, returns, or logs it, because the file *is* the
        /// credential. Cursor's SDK sign-in lives in a file the SDK owns, not
        /// in this app's Keychain, so a Keychain lookup cannot see it. `~` is
        /// the operator's home.
        case filePresence(path: String)
    }

    /// Whether an unsatisfied prerequisite blocks setup for the runner it
    /// belongs to. Claude Code's CLI is `informational`: the Agent SDK runs
    /// turns with the CLI it bundles, so a missing local binary costs only a
    /// possibly-stale model list.
    enum Requirement: Equatable {
        case required
        case informational
    }

    var id: String
    var kind: Kind
    var requirement: Requirement
    /// Label and symbol for the pane's re-run button.
    var actionTitle: String
    var actionSymbol: String
    var messages: RunnerBootstrapProbeMessages
    /// A stored choice that makes this probe `informational`, for a value one
    /// setup mode never reads. DeepSeek's composition is the case: managed
    /// setup generates its own graph, so only custom setup needs the file, and
    /// asking a managed operator to supply one would block setup on a value the
    /// backend ignores.
    var waivedBy: RunnerBootstrapChoiceSelection? = nil

    /// The requirement that applies to the slot values stored now. A closure
    /// that knows no values leaves the declared requirement in force.
    func effectiveRequirement(storedValue: (String) -> String?) -> Requirement {
        isWaived(storedValue: storedValue) ? .informational : requirement
    }

    /// Whether the stored choice makes this probe's value unused.
    func isWaived(storedValue: (String) -> String?) -> Bool {
        waivedBy?.isSelected(storedValue: storedValue) == true
    }

    func message(for status: RunnerBootstrapCheckStatus) -> String {
        switch status {
        case .satisfied(let detail):
            messages.filled(messages.satisfied, with: detail)
        case .detected(let detail):
            messages.filled(messages.detected, with: detail)
        case .absent:
            messages.absent
        case .failed(let message):
            message
        }
    }

    /// The setup-checklist line this probe contributes, or `nil` when it
    /// contributes none — because it is satisfied, or because it does not block
    /// under the stored slot values.
    func blockingItem(
        for status: RunnerBootstrapCheckStatus?,
        storedValue: (String) -> String? = { _ in nil }
    ) -> String? {
        guard effectiveRequirement(storedValue: storedValue) == .required else { return nil }
        switch status {
        case .some(let status) where status.isSatisfied:
            return nil
        case .some(.failed):
            return messages.blockingFailed
        case .some(.absent):
            return messages.blockingAbsent
        default:
            return messages.blockingUnchecked
        }
    }

    /// The slot whose row shows this probe: the slot it resolves, or the one
    /// whose value it checks. A Node entrypoint check reads the Arguments
    /// value, so it belongs on that row rather than above the whole section.
    var displaySlotID: String? {
        if case .nodeEntrypoint(_, let argumentsSlotID, _) = kind {
            return argumentsSlotID
        }
        return resolvedSlotID
    }

    /// The slot this probe resolves a value into, if any.
    var resolvedSlotID: String? {
        switch kind {
        case .executablePath(let slotID, _):
            slotID
        case .filePath(let slotID):
            slotID
        case .keychainPresence, .filePresence, .nodeEntrypoint:
            nil
        }
    }
}
