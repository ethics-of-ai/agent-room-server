import SwiftUI

struct StatusHeroCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            StatusOrb(state: supervisor.serverState)

            VStack(alignment: .leading, spacing: 8) {
                Text(supervisor.serverState.statusTitle)
                    .font(.title2.bold())
                Text(supervisor.serverState.statusDetail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: DashboardTheme.elementSpacing) {
                    StatusPill(
                        label: supervisor.connectionState.rawValue,
                        systemImage: supervisor.connectionState.systemImage,
                        tint: supervisor.connectionState.tint
                    )

                    if let release = supervisor.health?.release {
                        Text("Backend \(release.backendVersion) · API \(release.apiVersion)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .padding(.top, 4)

                StatusHeroActionButton()
                    .padding(.top, 4)
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: DashboardTheme.tightSpacing) {
                Text("Local URL")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .textCase(.uppercase)
                Text(supervisor.localServerURLString)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .cardBackground()
    }
}
