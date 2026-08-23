import Foundation

struct SetupReadiness: Equatable {
    var settings: AppSettings
    /// The default runner the backend will start with, resolved from the managed
    /// settings file rather than app preferences, since that is where it now
    /// lives. A backend runner id, never coerced to a known one: bootstrap
    /// checks are per-runner, and running Codex's check for a runner that is not
    /// Codex would report readiness it never established.
    var runnerKind: String
    var secrets: BackendSecretValues
    /// The bundled bootstrap contract for that runner, or `nil` when this build
    /// has none — a runner registered by a newer backend, say. Silence is the
    /// honest answer there: this app cannot say whether that runner's local
    /// prerequisites are met, and asserting another runner's answer would be
    /// worse than saying nothing.
    var bootstrapDescriptor: RunnerBootstrapDescriptor?
    /// Every probe outcome the supervisor holds, keyed `runnerKind/probeID`.
    var bootstrapStatuses: [String: RunnerBootstrapCheckStatus]
    var connectionState: BackendConnectionState
    var hasLANURL: Bool

    var resolvedRunnerKind: String {
        runnerKind
    }

    var isReadyForVisionOS: Bool {
        blockingItems.isEmpty
    }

    var blockingItems: [String] {
        var items: [String] = []
        if connectionState != .reachable {
            items.append("Start or connect to the local backend.")
        }
        if settings.workspacePath.trimmedForSetup.isEmpty || settings.statePath.trimmedForSetup.isEmpty {
            items.append("Set workspace and state locations.")
        }
        items.append(contentsOf: bootstrapBlockingItems)
        if secrets.authToken.trimmedForSetup.isEmpty {
            items.append("Create an AgentRoom auth token for paired clients.")
        }
        if !hasLANURL {
            items.append("Connect the Mac to a network with a LAN address.")
        }
        return items
    }

    /// The default runner's own unmet prerequisites. Only that runner's: a
    /// Codex CLI the operator never installed is not a setup failure when the
    /// backend is going to start Claude Code.
    private var bootstrapBlockingItems: [String] {
        guard let bootstrapDescriptor else { return [] }
        return bootstrapDescriptor.probes.compactMap { probe in
            probe.blockingItem(for: resolvedStatus(for: probe, of: bootstrapDescriptor))
        }
    }

    /// The probe's own outcome, or — before any check has run — what the stored
    /// slot already implies. An operator whose executable path is saved and
    /// still valid is not asked to set it again just because the app has not
    /// re-probed yet.
    private func resolvedStatus(
        for probe: RunnerBootstrapProbe,
        of descriptor: RunnerBootstrapDescriptor
    ) -> RunnerBootstrapCheckStatus? {
        if let status = bootstrapStatuses["\(descriptor.runnerKind)/\(probe.id)"] {
            return status
        }
        guard let slotID = probe.resolvedSlotID,
              let stored = secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID),
              !stored.trimmedForSetup.isEmpty else {
            return nil
        }
        // Mere presence proves nothing for an operator-supplied data file: it
        // must pass the file probe before setup can call it satisfied. Executable
        // slots retain their pre-probe fallback for compatibility with saved CLI
        // paths; the supervisor validates every probe at launch either way.
        if descriptor.slot(slotID)?.kind == .filePath {
            return nil
        }
        return .satisfied(detail: stored)
    }
}

private extension Optional where Wrapped == String {
    var trimmedForSetup: String {
        self?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

private extension String {
    var trimmedForSetup: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
