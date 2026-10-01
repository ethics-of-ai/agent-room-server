import SwiftUI

struct SidebarStatusSummary: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.tightSpacing) {
            HStack(spacing: 8) {
                BackendStateSymbol(state: supervisor.serverState)
                Text(supervisor.serverState.statusTitle)
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ConnectionStateLabel(state: supervisor.connectionState)
        }
        .padding(.vertical, 4)
    }
}
