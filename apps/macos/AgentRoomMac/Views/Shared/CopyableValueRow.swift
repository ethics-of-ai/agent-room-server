import SwiftUI

struct CopyableValueRow: View {
    var label: String
    var value: String
    var isEnabled: Bool = true

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 8) {
                Text(value)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .foregroundStyle(isEnabled ? .primary : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                CopyButton(value: value, isEnabled: isEnabled)
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
    }
}
