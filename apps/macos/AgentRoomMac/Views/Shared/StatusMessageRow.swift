import SwiftUI

/// A one-line status message: a tinted SF Symbol next to wrapping caption text.
/// Used for runner readiness rows (Codex executable, Claude Code sign-in).
struct StatusMessageRow: View {
    var message: String
    var style: StatusStyle

    var body: some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: style.systemImage)
        }
        .font(.caption)
        .foregroundStyle(style.tint)
    }
}
