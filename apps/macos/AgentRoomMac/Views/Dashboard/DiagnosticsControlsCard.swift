import SwiftUI

struct DiagnosticsControlsCard: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @Binding var isExporting: Bool
    var exportAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Diagnostics",
                systemImage: "stethoscope",
                subtitle: "Backend snapshots, app logs, and bundle export"
            )

            HStack(spacing: DashboardTheme.elementSpacing) {
                Button("Refresh", systemImage: "arrow.clockwise", action: refreshDiagnosticsData)
                    .buttonStyle(.bordered)

                Button("Export Diagnostics", systemImage: "square.and.arrow.down", action: exportAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(isExporting)

                Spacer()

                Button("Reset", systemImage: "trash", role: .destructive, action: supervisor.resetLocalDiagnostics)
                    .buttonStyle(.bordered)
            }

            if let message = supervisor.diagnosticsExportMessage {
                Label(message, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.top, 2)
            }
        }
        .cardBackground()
    }

    private func refreshDiagnosticsData() {
        Task { await supervisor.refreshDiagnosticsData() }
    }
}
