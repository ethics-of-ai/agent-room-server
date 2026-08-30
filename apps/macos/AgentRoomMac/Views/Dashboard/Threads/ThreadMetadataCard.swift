import SwiftUI

struct ThreadMetadataCard: View {
    var session: AgentSession
    var isCancelling: Bool
    var stopAction: () -> Void
    @State private var isRawSnapshotExpanded = false

    private var style: ThreadStatusStyle {
        ThreadStatusStyle.style(for: session.status)
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

            VStack(alignment: .leading, spacing: DashboardTheme.elementSpacing) {
                InfoRow(label: "Workspace", value: session.workspacePath)
                InfoRow(label: "Branch", value: session.gitBranch ?? "Not recorded", isMonospaced: false)
                InfoRow(label: "Runner", value: session.runnerKind, isMonospaced: false)
                InfoRow(label: "Settings", value: session.threadSettingsLabel, isMonospaced: false)
                InfoRow(label: "Active turn", value: session.activeTurnId ?? "None")
                InfoRow(label: "Created", value: session.createdAt.threadTimestampDisplay)
                InfoRow(label: "Updated", value: session.updatedAt.threadTimestampDisplay)
                InfoRow(label: "Last message", value: session.lastMessage ?? "None", isMonospaced: false)
            }

            ThreadContextWindowView(
                fraction: session.threadContextUsageFraction,
                compactionFraction: session.threadContextCompactionFraction,
                label: session.threadContextUsageLabel,
                compactionLabel: session.threadContextCompactionLabel
            )

            // The pretty-printed encode of the whole session runs only while the
            // disclosure is actually open; unconditioned, it ran on every render
            // of this card (every poll tick while a session was selected).
            DisclosureGroup("Raw session snapshot", isExpanded: $isRawSnapshotExpanded) {
                if isRawSnapshotExpanded {
                    CodeBlockView(text: session.threadRawJSON, minHeight: 160)
                        .padding(.top, 8)
                }
            }
        }
        .cardBackground()
    }
}
