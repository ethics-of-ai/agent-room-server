import SwiftUI

struct PairingURLsCard: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        // Each of these walks the network interfaces (getifaddrs) or queries
        // SCDynamicStore; hoist to one lookup per render instead of one per
        // reference below.
        let hostnameURL = supervisor.macHostnameServerURLString
        let lanIPURLs = supervisor.lanIPAddressServerURLStrings
        let primaryLANURL = hostnameURL ?? lanIPURLs.first
        VStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
            CardHeader(
                title: "Pairing URLs",
                systemImage: "network",
                subtitle: "Endpoints for the Vision Pro Simulator and Physical Vision Pro"
            )

            VStack(alignment: .leading, spacing: 8) {
                CopyableValueRow(label: "Simulator", value: supervisor.localServerURLString)

                if let hostnameURL {
                    CopyableValueRow(label: "Mac hostname", value: hostnameURL)
                } else {
                    InfoRow(label: "Mac hostname", value: "No .local hostname detected", isMonospaced: false)
                }

                if lanIPURLs.isEmpty {
                    InfoRow(label: "LAN IP", value: "No LAN IP detected", isMonospaced: false)
                } else {
                    ForEach(lanIPURLs, id: \.self) { url in
                        CopyableValueRow(label: "LAN IP", value: url)
                    }
                }
            }

            Text("Use the simulator URL for the Vision Pro Simulator. Use the Mac hostname or a LAN IP URL for a Physical Vision Pro on the same network.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: DashboardTheme.elementSpacing) {
                CopyButton(value: supervisor.localServerURLString, title: "Copy Simulator URL", showsTitle: true)
                    .buttonStyle(.bordered)

                CopyButton(
                    value: primaryLANURL ?? "No LAN address detected",
                    title: "Copy Physical Vision Pro URL",
                    showsTitle: true,
                    isEnabled: primaryLANURL != nil
                )
                .buttonStyle(.bordered)
            }
            .padding(.top, 2)
        }
        .cardBackground()
    }
}
