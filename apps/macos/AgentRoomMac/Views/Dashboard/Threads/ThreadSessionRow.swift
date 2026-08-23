import SwiftUI

struct ThreadSessionRow: View {
    var session: AgentSession

    private var style: ThreadStatusStyle {
        ThreadStatusStyle.style(for: session.status)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: style.systemImage)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(style.tint)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 5) {
                Text(session.threadDisplayTitle)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)

                Text(session.threadWorkspaceName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 8) {
                    Text(style.label)
                        .foregroundStyle(style.tint)
                    Text(session.gitBranch ?? "No branch")
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
        .accessibilityElement(children: .combine)
    }
}
