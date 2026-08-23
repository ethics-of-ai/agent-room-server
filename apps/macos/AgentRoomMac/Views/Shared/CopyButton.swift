import SwiftUI

/// Copy-to-clipboard button that confirms the copy by briefly flipping to a
/// checkmark. Defaults to icon-only; pass `showsTitle: true` for a labeled button.
struct CopyButton: View {
    var value: String
    var title: String = "Copy"
    var showsTitle: Bool = false
    var isEnabled: Bool = true

    @State private var didCopy = false

    var body: some View {
        Button(action: copy) {
            let label = Label(didCopy ? "Copied" : title, systemImage: didCopy ? "checkmark" : "doc.on.doc")
            if showsTitle {
                label
            } else {
                label.labelStyle(.iconOnly)
            }
        }
        .help(title)
        .disabled(!isEnabled)
        .foregroundStyle(didCopy ? AnyShapeStyle(.green) : AnyShapeStyle(.primary))
        .sensoryFeedback(trigger: didCopy) { _, copied in copied ? .success : nil }
        .task(id: didCopy) {
            guard didCopy else { return }
            try? await Task.sleep(for: .seconds(1.2))
            didCopy = false
        }
    }

    private func copy() {
        Clipboard.copy(value)
        withAnimation { didCopy = true }
    }
}
