import SwiftUI

/// One runner's two readiness authorities: the backend runtime row is always
/// present, while local probes and tier-3 slots require a bundled descriptor.
///
/// The optional shape is deliberate. A runner registered after this app shipped
/// still exposes the safe/public runtime answer, but receives no local check and
/// no launch-environment grant from another runner's descriptor.
struct RunnerBootstrapSection: View {
    @Environment(BackendSupervisor.self) private var supervisor

    let runner: RunnerDescriptor
    let descriptor: RunnerBootstrapDescriptor?

    var body: some View {
        Section(runner.displayName) {
            if let descriptor {
                // A probe resolving no slot leads: it asks about the machine
                // rather than about a value held here, and it is the
                // prerequisite the fields below are worth filling in for. The
                // Claude Code sign-in lookup is the case, and its descriptor
                // already declared it first.
                ForEach(slotlessProbes(in: descriptor)) { probe in
                    probeButton(for: probe, descriptor: descriptor)
                    probeStatus(for: probe, descriptor: descriptor)
                }
                // Before the fields it fills, because it is the shorter way to
                // the same place: an operator who has a checkout should not be
                // asked to type three absolute paths out of it first.
                if descriptor.sourceCheckout != nil {
                    sourceCheckoutControls(for: descriptor)
                }
                // Then slot order, not probe order. A value and the probe that
                // resolves it are one row, and a slot completing another —
                // DeepSeek's entrypoint completing its interpreter — has to
                // follow it. Ordering by probe put an unrelated required check
                // between that pair.
                ForEach(descriptor.slots) { slot in
                    slotRow(for: slot, descriptor: descriptor)
                }
                // Section-level captions are for what belongs to no single
                // slot. Anything about one value rides that slot instead, so it
                // is read where it applies.
                ForEach(descriptor.notes) { note in
                    SettingsCaption(text: note.text, systemImage: note.systemImage)
                }
            }
            RunnerRuntimeReadinessRow(runnerKind: runner.runnerKind)
        }
    }

    private func slotlessProbes(in descriptor: RunnerBootstrapDescriptor) -> [RunnerBootstrapProbe] {
        descriptor.probes.filter { $0.resolvedSlotID == nil }
    }

    @ViewBuilder
    private func sourceCheckoutControls(for descriptor: RunnerBootstrapDescriptor) -> some View {
        Button("Use a source checkout…", systemImage: "folder.badge.gearshape") {
            guard let root = chooseCheckoutFolder(runnerName: runner.displayName) else { return }
            supervisor.adoptSourceCheckout(root, of: descriptor)
        }
        .buttonStyle(.bordered)
        if let outcome = supervisor.sourceCheckoutOutcomes[descriptor.runnerKind] {
            // Required styling: a walk the operator explicitly asked for that
            // came back empty is a failure to report, not a neutral state.
            StatusMessageRow(message: outcome.message, style: outcome.status.style(for: .required))
        }
    }

    /// Matches the folder pickers the workspace and catalog panes already use,
    /// rather than `fileImporter`: this is a modal operator action on macOS, and
    /// one picker idiom in the app beats two.
    private func chooseCheckoutFolder(runnerName: String) -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Select the \(runnerName) source checkout. Its built entrypoint and example composition are read from it."
        panel.prompt = "Use Checkout"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        return panel.runModal() == .OK ? panel.url : nil
    }

    @ViewBuilder
    private func slotRow(
        for slot: RunnerBootstrapSlot,
        descriptor: RunnerBootstrapDescriptor
    ) -> some View {
        let probe = descriptor.probes.first { $0.resolvedSlotID == slot.id }
        if let probe {
            HStack(alignment: .firstTextBaseline) {
                slotField(for: slot, descriptor: descriptor)
                probeButton(for: probe, descriptor: descriptor)
            }
            probeStatus(for: probe, descriptor: descriptor)
        } else {
            slotField(for: slot, descriptor: descriptor)
        }
        if let note = slot.note {
            SettingsCaption(text: note.text, systemImage: note.systemImage)
        }
    }

    private func probeButton(
        for probe: RunnerBootstrapProbe,
        descriptor: RunnerBootstrapDescriptor
    ) -> some View {
        Button(probe.actionTitle, systemImage: probe.actionSymbol) {
            supervisor.checkRunnerBootstrap(probe, of: descriptor)
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder
    private func probeStatus(
        for probe: RunnerBootstrapProbe,
        descriptor: RunnerBootstrapDescriptor
    ) -> some View {
        if let status = supervisor.bootstrapStatus(runnerKind: descriptor.runnerKind, probeID: probe.id) {
            StatusMessageRow(message: probe.message(for: status), style: status.style(for: probe.requirement))
        }
    }

    private func slotField(
        for slot: RunnerBootstrapSlot,
        descriptor: RunnerBootstrapDescriptor
    ) -> some View {
        RunnerBootstrapSlotField(
            slot: slot,
            storedValue: supervisor.secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slot.id) ?? ""
        ) { value in
            supervisor.updateRunnerBootstrapSlot(value, runnerKind: descriptor.runnerKind, slotID: slot.id)
        }
    }
}
