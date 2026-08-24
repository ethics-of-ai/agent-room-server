import SwiftUI

struct DashboardToolbar: ToolbarContent {
    @Environment(BackendSupervisor.self) private var supervisor
    @Environment(BackendThreadMirrorStore.self) private var threadMirrorStore
    var selectedSection: DashboardSection
    @Binding var confirmingRestart: Bool

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button("Refresh", systemImage: "arrow.clockwise", action: refreshConnectionStatus)
                .help("Refresh status and safe connection checks")

            Menu {
                Button("Start Backend", systemImage: "play.fill", action: supervisor.startServer)
                    .disabled(!supervisor.canStartBackend)

                Button("Stop Backend", systemImage: "stop.fill", action: supervisor.stopServer)
                    .disabled(!supervisor.canStopBackend)

                Divider()

                Button("Restart Server", systemImage: "arrow.clockwise.circle", action: requestRestart)
                    .disabled(!supervisor.canRestartBackend)
            } label: {
                Label("Backend", systemImage: "power.circle")
            }
            .help("Backend lifecycle controls")
        }
    }

    private func requestRestart() {
        confirmingRestart = true
    }

    private func refreshConnectionStatus() {
        Task {
            await supervisor.refreshConnectionStatus()
            if selectedSection == .threads {
                await threadMirrorStore.refresh(using: supervisor.currentAPIClient())
            }
        }
    }
}
