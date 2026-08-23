import SwiftUI

struct SettingsCaption: View {
    var text: String
    var systemImage: String = "info.circle"

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage)
                .symbolRenderingMode(.hierarchical)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
