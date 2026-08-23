import SwiftUI

struct InfoRow: View {
    var label: String
    var value: String
    var isMonospaced: Bool = true

    var body: some View {
        LabeledContent(label) {
            Text(value)
                .font(isMonospaced ? .system(.body, design: .monospaced) : .body)
                .textSelection(.enabled)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
