import SwiftUI

struct ThreadSessionRow: View {
    var row: ThreadListRow
    /// The branch the workspace's checkout is on now; see `ThreadCheckoutBranch`.
    /// For a child that is its worktree's branch.
    var branch: String

    private var session: AgentSession { row.session }

    private var style: ThreadStatusStyle {
        ThreadStatusStyle.style(for: session)
    }

    var body: some View {
        HStack(alignment: .top, spacing: DashboardTheme.elementSpacing) {
            Image(systemName: style.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(style.tint)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 5) {
                Text(session.threadDisplayTitle)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)

                Text(row.parentLine ?? session.threadWorkspaceName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 8) {
                    Text(style.label)
                        .foregroundStyle(style.tint)
                    if row.isChild {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .labelStyle(.titleAndIcon)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(branch)
                    }
                    Text("\(session.turnCount.formatted()) turns")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)

                Text(session.threadContextUsageLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .padding(.leading, row.isIndented ? 20 : 0)
        .accessibilityElement(children: .combine)
    }
}
