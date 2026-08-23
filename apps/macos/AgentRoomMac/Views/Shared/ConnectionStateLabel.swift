import SwiftUI

/// Compact connection-state indicator: a tinted reachability glyph next to the
/// state name. Shared by the sidebar summary and the menu-bar header.
struct ConnectionStateLabel: View {
    var state: BackendConnectionState

    var body: some View {
        HStack(spacing: DashboardTheme.tightSpacing) {
            Image(systemName: state.systemImage)
                .foregroundStyle(state.tint)
            Text(state.rawValue)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
