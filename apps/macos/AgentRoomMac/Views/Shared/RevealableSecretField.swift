import SwiftUI

/// A secret entry field that masks its value unless the caller reveals it.
///
/// Revealing swaps the `SecureField` for a monospaced `TextField`. The swap
/// replaces the control, so a field that was being edited loses focus.
struct RevealableSecretField: View {
    let title: String
    @Binding var text: String
    var prompt: Text?
    let isRevealed: Bool

    var body: some View {
        if isRevealed {
            TextField(title, text: $text, prompt: prompt)
                .font(.system(.body, design: .monospaced))
        } else {
            SecureField(title, text: $text, prompt: prompt)
        }
    }
}
