import SwiftUI

struct BackendLogsCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Backend logs",
                systemImage: "terminal",
                subtitle: "stdout and stderr from the app-owned backend process"
            )

            if supervisor.processLogs.isEmpty {
                ContentUnavailableView(
                    "No backend output yet",
                    systemImage: "terminal",
                    description: Text("Start the backend to capture stdout and stderr here.")
                )
                .frame(minHeight: 140)
            } else {
                LogList(
                    rows: supervisor.processLogs.prefix(40).map { line in
                        LogRowItem(
                            id: line.id,
                            timestamp: line.timestamp,
                            tag: line.stream.rawValue,
                            message: line.message,
                            isError: line.stream == .stderr
                        )
                    }
                )
            }
        }
        .cardBackground()
    }
}
