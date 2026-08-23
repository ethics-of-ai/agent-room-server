import SwiftUI

struct LogRow: View {
    var item: LogRowItem

    @ScaledMetric private var timeColumnWidth: CGFloat = 70
    @ScaledMetric private var tagColumnWidth: CGFloat = 56

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(item.timestamp, style: .time)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: timeColumnWidth, alignment: .leading)

            Text(item.tag.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(item.isError ? Color.red : Color.secondary)
                .frame(width: tagColumnWidth, alignment: .leading)

            Text(item.message)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
    }
}
