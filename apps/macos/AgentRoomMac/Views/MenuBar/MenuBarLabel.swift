import SwiftUI

/// The macOS menu bar status item. Shows the AgentRoom mark as an
/// appearance-adaptive monochrome glyph so the menu bar carries the brand
/// instead of a generic system symbol, while still signaling backend state:
/// dimmed when stopped and badged when it needs attention. Precise status lives
/// in the popover (`MenuBarStatusView`) and the dashboard.
struct MenuBarLabel: View {
    let state: BackendServerState

    var body: some View {
        Label {
            Text("AgentRoom")
        } icon: {
            Image(nsImage: AgentRoomMenuBarIcon.image())
                .renderingMode(.template)
        }
        .labelStyle(.iconOnly)
        .opacity(state == .stopped ? 0.55 : 1)
        .overlay(alignment: .topTrailing) {
            if state == .failed {
                // Shape-bearing badge (not a bare colored dot) so the failure
                // state stays distinguishable under Differentiate Without Color.
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.red)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityLabel(Text("AgentRoom"))
        .accessibilityValue(Text(state.statusTitle))
    }
}
