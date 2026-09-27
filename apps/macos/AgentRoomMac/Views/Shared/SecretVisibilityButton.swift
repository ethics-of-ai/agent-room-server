import SwiftUI

/// The eye toggle beside a `RevealableSecretField`.
struct SecretVisibilityButton: View {
    /// What the secret is called in the button title, such as "token".
    let subject: String
    let isRevealed: Bool
    let action: () -> Void

    var body: some View {
        let title = isRevealed ? "Hide \(subject)" : "Show \(subject)"
        Button(title, systemImage: isRevealed ? "eye.slash" : "eye", action: action)
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help(title)
    }
}
