import SwiftUI

struct StatusHeroCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
            HStack(alignment: .top, spacing: DashboardTheme.cardSpacing) {
                BackendStateSymbol(state: supervisor.serverState).font(.title2)
                VStack(alignment: .leading, spacing: DashboardTheme.tightSpacing) {
                    Text(supervisor.serverState.statusTitle).font(.title2.bold())
                    Text(supervisor.serverState.statusDetail)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                StatusHeroActionButton()
            }
            HStack(spacing: DashboardTheme.elementSpacing) {
                StatusPill(
                    label: supervisor.connectionState.rawValue,
                    systemImage: supervisor.connectionState.systemImage,
                    tint: supervisor.connectionState.tint
                )
                Text(supervisor.localServerURLString)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                if let release = supervisor.health?.release {
                    Text("Backend \(release.backendVersion) · API \(release.apiVersion)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, DashboardTheme.elementSpacing)
    }
}
