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
                if let contract = descriptor.sourceCheckout {
                    RunnerSourceCheckoutControls(
                        runnerName: runner.displayName,
                        descriptor: descriptor,
                        contract: contract
                    )
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
            if let descriptor, let signIn = descriptor.signIn {
                RunnerSignInRow(descriptor: descriptor, signIn: signIn)
            }
        }
    }

    private func slotlessProbes(in descriptor: RunnerBootstrapDescriptor) -> [RunnerBootstrapProbe] {
        descriptor.probes.filter { $0.displaySlotID == nil }
    }

    @ViewBuilder
    private func slotRow(
        for slot: RunnerBootstrapSlot,
        descriptor: RunnerBootstrapDescriptor
    ) -> some View {
        let probe = descriptor.probes.first { $0.displaySlotID == slot.id }
        let storedValue = { (slotID: String) in
            supervisor.secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID)
        }
        // A value the stored setup never reads is hidden rather than shown as
        // optional: DeepSeek's composition under managed setup is the case,
        // and an unused path field is one more thing to wonder about.
        if probe?.isWaived(storedValue: storedValue) != true {
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
        if let status = supervisor.bootstrapStatus(runnerKind: descriptor.runnerKind, probeID: probe.id),
           !isReportedByCheckout(status, of: probe, descriptor: descriptor) {
            let requirement = probe.effectiveRequirement { slotID in
                supervisor.secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID)
            }
            StatusMessageRow(message: probe.message(for: status), style: status.style(for: requirement))
        }
    }

    /// A failed check on a checkout's entrypoint that the checkout row above
    /// already reports, with its Update or Build button. Saying it twice adds
    /// a second red line and no second thing to do.
    private func isReportedByCheckout(
        _ status: RunnerBootstrapCheckStatus,
        of probe: RunnerBootstrapProbe,
        descriptor: RunnerBootstrapDescriptor
    ) -> Bool {
        guard !status.isSatisfied,
              let contract = descriptor.sourceCheckout,
              let slotID = probe.displaySlotID,
              slotID == contract.entrypointSlotID
        else { return false }
        return contract.offersRepair(
            supervisor.sourceCheckoutOutcomes[descriptor.runnerKind],
            forEntrypointIn: supervisor.secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID)
        )
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
