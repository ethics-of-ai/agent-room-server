import SwiftUI

struct ThreadMetadataCard: View {
    var session: AgentSession
    var isCancelling: Bool
    var stopAction: () -> Void

    private var style: ThreadStatusStyle {
        ThreadStatusStyle.style(for: session)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
            HStack(alignment: .top, spacing: 12) {
                CardHeader(
                    title: session.threadDisplayTitle,
                    systemImage: "text.bubble.fill",
                    subtitle: "Server session metadata"
                )

                Spacer()

                StatusPill(label: style.label, systemImage: style.systemImage, tint: style.tint)
            }

            HStack(spacing: DashboardTheme.elementSpacing) {
                Button("Stop Turn", systemImage: "stop.circle", action: stopAction)
                    .disabled(!session.threadIsRunning || isCancelling)
                    .help("Ask the backend to cancel the active turn")

                CopyButton(value: session.id, title: "Copy ID", showsTitle: true)

                CopyButton(value: session.workspacePath, title: "Copy Path", showsTitle: true)

                if isCancelling {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            DisclosureGroup("Session details") {
                ScrollView {
                    ThreadSessionDetails(session: session)
                }
                .frame(maxHeight: 200)
            }
        }
        .cardBackground()
    }
}
