import SwiftUI

struct MenuBarHeader: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BackendStateSymbol(state: supervisor.serverState).font(.title2)

            VStack(alignment: .leading, spacing: 4) {
                Text(supervisor.serverState.statusTitle)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)

                ConnectionStateLabel(state: supervisor.connectionState)

                Text(supervisor.localServerURLString)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 0)
        }
    }
}
