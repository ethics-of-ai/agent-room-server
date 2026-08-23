import SwiftUI

struct StatusPill: View {
    var label: String
    var systemImage: String
    var tint: Color = .accentColor

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .symbolRenderingMode(.hierarchical)
            Text(label)
        }
        .font(.callout.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(tint.opacity(0.14), in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(tint.opacity(0.22))
        }
    }
}
