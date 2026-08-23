import SwiftUI

struct ConfigurationCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Configuration",
                systemImage: "slider.horizontal.3",
                subtitle: "Active settings injected into the backend at launch"
            )

            VStack(alignment: .leading, spacing: 10) {
                InfoRow(label: "Port", value: String(supervisor.settings.serverPort))
                InfoRow(label: "Workspace path", value: supervisor.settings.workspacePath)
                InfoRow(label: "State path", value: supervisor.settings.statePath)
                InfoRow(label: "AgentRoom home", value: supervisor.settings.agentRoomHomePath)
                InfoRow(
                    label: "Launch at login",
                    value: supervisor.settings.launchAtLoginEnabled ? "Enabled" : "Disabled",
                    isMonospaced: false
                )
                InfoRow(
                    label: "Crash auto-restart",
                    value: supervisor.settings.autoRestartBackendAfterCrash
                        ? "Enabled · 3 attempts in 5 minutes"
                        : "Disabled",
                    isMonospaced: false
                )
            }
        }
        .cardBackground()
    }
}
