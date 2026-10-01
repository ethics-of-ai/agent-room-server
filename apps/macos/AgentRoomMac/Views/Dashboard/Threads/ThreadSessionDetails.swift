import SwiftUI

struct ThreadSessionDetails: View {
    var session: AgentSession
    @State private var isRawSnapshotExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.elementSpacing) {
            InfoRow(label: "Workspace", value: session.workspacePath)
            InfoRow(label: "Branch", value: session.gitBranch ?? "Not recorded", isMonospaced: false)
            InfoRow(label: "Runner", value: session.runnerKind, isMonospaced: false)
            InfoRow(label: "Settings", value: session.threadSettingsLabel, isMonospaced: false)
            InfoRow(label: "Active turn", value: session.activeTurnId ?? "None")
            InfoRow(label: "Created", value: session.createdAt.threadTimestampDisplay)
            InfoRow(label: "Updated", value: session.updatedAt.threadTimestampDisplay)
            InfoRow(label: "Last message", value: session.lastMessage ?? "None", isMonospaced: false)
            ThreadContextWindowView(
                fraction: session.threadContextUsageFraction,
                compactionFraction: session.threadContextCompactionFraction,
                label: session.threadContextUsageLabel,
                compactionLabel: session.threadContextCompactionLabel
            )
            DisclosureGroup("Raw session snapshot", isExpanded: $isRawSnapshotExpanded) {
                if isRawSnapshotExpanded {
                    CodeBlockView(text: session.threadRawJSON, minHeight: 160)
                }
            }
        }
    }
}
