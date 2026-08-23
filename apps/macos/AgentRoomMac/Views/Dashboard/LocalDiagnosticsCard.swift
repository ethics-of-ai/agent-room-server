import SwiftUI

struct LocalDiagnosticsCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "App diagnostics",
                systemImage: "list.bullet.rectangle",
                subtitle: "Recent local events captured by the macOS app"
            )

            if supervisor.diagnostics.isEmpty {
                ContentUnavailableView(
                    "No diagnostics yet",
                    systemImage: "list.bullet.rectangle",
                    description: Text("Settings changes and connection checks will appear here.")
                )
                .frame(minHeight: 140)
            } else {
                LogList(
                    rows: supervisor.diagnostics.prefix(20).map { item in
                        LogRowItem(
                            id: item.id,
                            timestamp: item.timestamp,
                            tag: item.level,
                            message: item.message,
                            isError: item.level.lowercased() == "error" || item.level.lowercased() == "warning"
                        )
                    }
                )
            }
        }
        .cardBackground()
    }
}
