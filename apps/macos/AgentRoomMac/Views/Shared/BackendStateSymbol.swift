import SwiftUI

struct BackendStateSymbol: View {
    var state: BackendServerState

    var body: some View {
        Image(systemName: state.statusSystemImage)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(state.tint)
            .accessibilityHidden(true)
    }
}
