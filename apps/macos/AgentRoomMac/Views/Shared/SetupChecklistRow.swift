import SwiftUI

struct SetupChecklistRow: View {
    var label: String
    var isComplete: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: isComplete ? "checkmark.circle.fill" : "circle.dotted")
                .font(.body.weight(.semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(isComplete ? .green : .orange)
                .frame(width: 20)
            Text(label)
                .font(.callout.weight(.medium))
            Spacer(minLength: 0)
        }
    }
}
