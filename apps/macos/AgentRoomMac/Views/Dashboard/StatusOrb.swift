import SwiftUI

struct StatusOrb: View {
    var state: BackendServerState
    var size: CGFloat = 76

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(state.tint.opacity(0.16))
            .overlay {
                Circle().strokeBorder(state.tint.opacity(0.28), lineWidth: 1)
            }
            .overlay {
                Image(systemName: state.statusSystemImage)
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(state.tint)
                    .symbolEffect(.pulse, options: .repeating, isActive: state.isTransient && !reduceMotion)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
