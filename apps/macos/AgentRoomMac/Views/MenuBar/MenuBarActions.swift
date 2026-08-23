import SwiftUI

struct MenuBarActions: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(spacing: 2) {
            MenuBarAction(label: "Refresh Status", systemImage: "arrow.clockwise", action: refreshConnectionStatus)
            MenuBarAction(
                label: "Start Server",
                systemImage: "play.fill",
                isDisabled: !supervisor.serverState.canStart,
                action: supervisor.startServer
            )
            MenuBarAction(
                label: "Stop Server",
                systemImage: "stop.fill",
                isDisabled: !supervisor.serverState.canStop,
                action: supervisor.stopServer
            )
            MenuBarAction(
                label: "Restart Server",
                systemImage: "arrow.clockwise.circle",
                isDisabled: !supervisor.serverState.canRestart,
                action: supervisor.restartServer
            )
        }
    }

    private func refreshConnectionStatus() {
        Task { await supervisor.refreshConnectionStatus() }
    }
}
