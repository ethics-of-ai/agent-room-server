import SwiftUI

struct ThreadContextWindowView: View {
    var fraction: Double?
    var label: String

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.tightSpacing) {
            Text("Context window")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let fraction {
                ProgressView(value: fraction)
                    .controlSize(.small)
            }
            Text(label)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }
}
