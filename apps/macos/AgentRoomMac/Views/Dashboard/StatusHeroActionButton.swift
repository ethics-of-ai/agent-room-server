import SwiftUI

/// Contextual primary lifecycle action shown in the status hero: Start when the
/// backend is stoppable, Restart (confirmed) while it is running.
struct StatusHeroActionButton: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var confirmingRestart = false

    var body: some View {
        if supervisor.serverState.canStart {
            Button("Start Backend", systemImage: "play.fill", action: supervisor.startServer)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        } else if supervisor.serverState.canRestart {
            Button("Restart Backend", systemImage: "arrow.clockwise.circle", action: requestRestart)
                .buttonStyle(.bordered)
                .controlSize(.large)
                .restartBackendConfirmation(isPresented: $confirmingRestart)
        }
    }

    private func requestRestart() {
        confirmingRestart = true
    }
}
