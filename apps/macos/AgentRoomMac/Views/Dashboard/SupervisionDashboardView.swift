import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct SupervisionDashboardView: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var selectedSection: DashboardSection = .backend
    @State private var isExportingDiagnostics = false

    var body: some View {
        NavigationSplitView {
            DashboardSidebarView(selectedSection: $selectedSection)
        } detail: {
            DashboardDetailContainer(
                selectedSection: selectedSection,
                isExportingDiagnostics: $isExportingDiagnostics,
                exportAction: exportDiagnostics,
                openEndpoint: openBackendEndpoint
            )
        }
        .task {
            await supervisor.refreshConnectionStatus()
        }
        .animation(DashboardTheme.stateAnimation, value: supervisor.serverState)
        .animation(DashboardTheme.stateAnimation, value: supervisor.connectionState)
    }

    private func exportDiagnostics() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "AgentRoom-Diagnostics-\(Self.diagnosticsTimestamp()).json"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }
        isExportingDiagnostics = true
        Task {
            await supervisor.writeDiagnosticsBundle(to: url)
            isExportingDiagnostics = false
        }
    }

    private func openBackendEndpoint(_ endpoint: String) {
        var url = supervisor.settings.localServerURL
        for component in endpoint.split(separator: "/") {
            url.appendPathComponent(String(component))
        }
        NSWorkspace.shared.open(url)
    }

    private static func diagnosticsTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date.now)
    }
}
