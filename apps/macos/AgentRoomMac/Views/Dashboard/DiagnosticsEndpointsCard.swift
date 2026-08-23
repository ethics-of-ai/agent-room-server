import SwiftUI

struct DiagnosticsEndpointsCard: View {
    @Environment(BackendSupervisor.self) private var supervisor
    var openEndpoint: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            CardHeader(
                title: "Backend endpoints",
                systemImage: "cable.connector",
                subtitle: "Safe JSON snapshots from the running backend"
            )

            DiagnosticsEndpointView(
                title: "Server Health",
                systemImage: "heart.text.square",
                path: "/health",
                value: supervisor.healthDiagnostics
            )
            DiagnosticsEndpointView(
                title: "Config Status",
                systemImage: "lock.shield",
                path: "/api/config",
                value: supervisor.configDiagnostics
            )
            DiagnosticsEndpointView(
                title: "Recent Logs",
                systemImage: "list.bullet.rectangle",
                path: "/api/logs",
                value: supervisor.recentLogsDiagnostics
            )
            DiagnosticsEndpointView(
                title: "Audit Trail",
                systemImage: "doc.text.magnifyingglass",
                path: "/api/audit",
                value: supervisor.auditTrailDiagnostics,
                openEndpoint: openEndpoint
            )
        }
        .cardBackground()
    }
}
