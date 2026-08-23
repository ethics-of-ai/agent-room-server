import SwiftUI

/// Shared confirmation for restarting the backend, so the destructive copy and
/// action live in one place instead of being duplicated across the dashboard
/// toolbar and the status hero card.
struct RestartBackendConfirmation: ViewModifier {
    @Environment(BackendSupervisor.self) private var supervisor
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content.confirmationDialog("Restart the backend?", isPresented: $isPresented) {
            Button("Restart", role: .destructive, action: supervisor.restartServer)
        } message: {
            Text("Any in-progress agent turns will be interrupted.")
        }
    }
}

extension View {
    func restartBackendConfirmation(isPresented: Binding<Bool>) -> some View {
        modifier(RestartBackendConfirmation(isPresented: isPresented))
    }
}
