import SwiftUI

struct SetupReadinessCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        let readiness = supervisor.setupReadiness

        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                CardHeader(
                    title: "Ready for visionOS",
                    systemImage: readiness.isReadyForVisionOS ? "visionpro.fill" : "visionpro",
                    subtitle: readiness.isReadyForVisionOS
                        ? "Backend, credentials, and LAN pairing look healthy."
                        : "Resolve the items below to pair a Vision Pro."
                )
                Spacer()
                StatusPill(
                    label: readiness.isReadyForVisionOS ? "Ready" : "Setup needed",
                    systemImage: readiness.isReadyForVisionOS ? "checkmark.circle.fill" : "exclamationmark.circle.fill",
                    tint: readiness.isReadyForVisionOS ? .green : .orange
                )
            }

            if !readiness.isReadyForVisionOS {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(readiness.blockingItems, id: \.self) { item in
                        SetupChecklistRow(label: item, isComplete: false)
                    }
                }
            }

            HStack(spacing: 10) {
                Button("Run safe checks", systemImage: "checkmark.seal", action: refreshConnectionStatus)
                    .buttonStyle(.bordered)

                SettingsLink {
                    Label("Open setup", systemImage: "gearshape")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.top, 2)
        }
        .cardBackground()
    }

    private func refreshConnectionStatus() {
        Task { @MainActor in
            // Every bundled bootstrap probe, whichever runners this build knows:
            // these read the operator's own machine, so they answer whether or
            // not the backend is running.
            supervisor.checkRunnerBootstrap()
            await supervisor.refreshConnectionStatus()
        }
    }
}
