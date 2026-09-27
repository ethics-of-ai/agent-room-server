import SwiftUI

/// The entry row for a runner's secret slot: a masked field with reveal and
/// remove beside it. Reveal matches the auth token row in Credentials. Remove
/// asks first, because AgentRoom keeps no other copy of the key.
///
/// `RunnerBootstrapSlotField` owns the draft, focus, and commit. This row only
/// lays them out, so a secret is written on the same terms as any other slot.
struct RunnerBootstrapSecretRow: View {
    let slot: RunnerBootstrapSlot
    @Binding var text: String
    @Binding var isRevealed: Bool
    var isFocused: FocusState<Bool>.Binding
    let canRemove: Bool
    let remove: () -> Void

    @State private var confirmingRemove = false

    var body: some View {
        // The buttons share the row, so the title moves to `LabeledContent` to
        // stay in the Form's label column.
        LabeledContent(slot.title) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    RevealableSecretField(
                        title: slot.title,
                        text: $text,
                        prompt: slot.prompt.map(Text.init),
                        isRevealed: isRevealed
                    )
                    .labelsHidden()
                    // A grouped Form trailing-aligns its fields, which puts the
                    // caret at the far right of an empty one.
                    .multilineTextAlignment(.leading)
                    .focused(isFocused)
                    SecretVisibilityButton(subject: slot.title, isRevealed: isRevealed, action: toggleReveal)
                    Button("Remove \(slot.title)", systemImage: "trash", role: .destructive) {
                        confirmingRemove = true
                    }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("Remove \(slot.title) from Keychain")
                        .disabled(!canRemove)
                }
                if isRevealed {
                    SettingsCaption(text: "\(slot.title) is visible.", systemImage: "eye")
                }
            }
        }
        .confirmationDialog("Remove \(slot.title)?", isPresented: $confirmingRemove) {
            Button("Remove", role: .destructive, action: remove)
        } message: {
            Text("This deletes the stored key from Keychain. The runner has no key until you enter one again.")
        }
    }

    /// Revealing mid-edit ends the edit. The swap replaces the control, and the
    /// focus loss commits the draft exactly as leaving the field any other way
    /// would, so reveal adds no second path for writing a value.
    private func toggleReveal() {
        isRevealed.toggle()
    }
}
