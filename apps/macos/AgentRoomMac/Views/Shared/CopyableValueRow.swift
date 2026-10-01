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
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(isEnabled ? .primary : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                CopyButton(value: value, title: "Copy \(label)", isEnabled: isEnabled)
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
