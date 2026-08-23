import SwiftUI

struct ThreadMirrorSummaryCard: View {
    var sessionCount: Int
    var runningCount: Int
    var idleCount: Int
    var failedCount: Int
    var totalTokens: Int
    var isRefreshing: Bool
    var lastRefreshedAt: Date?
    var lastError: String?
    var refreshAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                CardHeader(
                    title: "Thread mirror",
                    systemImage: "text.bubble",
                    subtitle: "Read-only view of server-owned agent sessions"
                )

                Spacer()

                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                }

                Button("Refresh", systemImage: "arrow.clockwise", action: refreshAction)
                    .help("Refresh sessions, selected messages, and recent events")
            }

            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 5) {
                GridRow {
                    Text("Sessions")
                    Text("Running")
                    Text("Idle")
                    Text("Failed")
                    Text("Tokens")
                    Text("Updated")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

                GridRow {
                    Text(sessionCount.formatted())
                        .accessibilityLabel("Sessions: \(sessionCount.formatted())")
                    Text(runningCount.formatted())
                        .accessibilityLabel("Running: \(runningCount.formatted())")
                    Text(idleCount.formatted())
                        .accessibilityLabel("Idle: \(idleCount.formatted())")
                    Text(failedCount.formatted())
                        .accessibilityLabel("Failed: \(failedCount.formatted())")
                    Text(totalTokens.formatted())
                        .accessibilityLabel("Tokens: \(totalTokens.formatted())")
                    Text(lastRefreshedLabel)
                        .accessibilityLabel("Updated: \(lastRefreshedLabel)")
                }
                .font(.callout.monospacedDigit())
                .textSelection(.enabled)
            }

            if let lastError, !lastError.isEmpty {
                Label(lastError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .cardBackground()
    }

    private var lastRefreshedLabel: String {
        guard let lastRefreshedAt else {
            return "Never"
        }
        return lastRefreshedAt.formatted(date: .omitted, time: .standard)
    }
}
