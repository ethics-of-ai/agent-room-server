import SwiftUI

struct ThreadEventRow: View {
    var event: AgentRoomEvent

    @ScaledMetric private var timeColumnWidth: CGFloat = 178
    @ScaledMetric private var typeColumnWidth: CGFloat = 190

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(event.at.threadTimestampDisplay)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: timeColumnWidth, alignment: .leading)
                .textSelection(.enabled)

            Text(event.type)
                .font(.caption.weight(.bold))
                .foregroundStyle(event.error == nil ? Color.secondary : Color.red)
                .frame(width: typeColumnWidth, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            Text(event.threadEventSummary)
                .font(.callout)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
