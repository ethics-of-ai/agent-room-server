import SwiftUI

struct MenuBarHeader: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusOrb(state: supervisor.serverState, size: 40)

            VStack(alignment: .leading, spacing: 4) {
                Text(supervisor.serverState.statusTitle)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)

                ConnectionStateLabel(state: supervisor.connectionState)

                Text(supervisor.localServerURLString)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 0)
        }
    }
}
