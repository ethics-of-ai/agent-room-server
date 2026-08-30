import SwiftUI

struct ThreadContextWindowView: View {
    var fraction: Double?
    /// Where the runner auto-compacts, as a share of the same bar. Absent for
    /// every runner that does not publish a threshold, and absent is the whole
    /// answer: no mark is drawn rather than one at a guessed fraction.
    var compactionFraction: Double?
    var label: String
    var compactionLabel: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.tightSpacing) {
            Text("Context window")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let fraction {
                ProgressView(value: fraction)
                    .controlSize(.small)
                    .overlay {
                        if let compactionFraction {
                            ThreadContextCompactionMarkLayout(fraction: compactionFraction) {
                                Rectangle()
                                    .fill(.secondary)
                                    .frame(width: 1.5)
                            }
                            .accessibilityHidden(true)
                        }
                    }
            }
            Text(label)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if let compactionLabel {
                // The mark is a hairline, which VoiceOver cannot read. This
                // line is what actually carries the threshold.
                Text(compactionLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
    }
}
