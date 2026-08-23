import SwiftUI

struct ThreadMessageRow: View {
    var message: AgentSessionMessage

    @ScaledMetric private var roleColumnWidth: CGFloat = 92

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Label(message.threadRoleLabel, systemImage: message.threadRoleSystemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(roleTint)
                .frame(width: roleColumnWidth, alignment: .leading)

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(message.status.capitalized)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(message.at.threadTimestampDisplay)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }

                Text(message.content.isEmpty ? " " : message.content)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let context = message.context {
                    ThreadMessageContextStrip(context: context)
                }
            }
        }
        .padding(12)
        .innerSurface()
        .accessibilityElement(children: .combine)
    }

    private var roleTint: Color {
        switch message.role.lowercased() {
        case "assistant":
            return .blue
        case "user":
            return .green
        case "tool":
            return .orange
        case "system":
            return .secondary
        default:
            return .accentColor
        }
    }
}
