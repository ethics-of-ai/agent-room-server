import SwiftUI

/// The settings panes' shared footer for the backend-owned settings file: the
/// pending-restart offer, and the way out of a file that cannot be parsed.
///
/// Both states belong to the file rather than to any one control, so they are
/// stated once per pane instead of being repeated under each toggle.
struct ManagedSettingsFileSection: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var isConfirmingRestart = false

    var body: some View {
        Section("Backend Settings File") {
            if let issue = supervisor.managedSettingsIssue {
                StatusMessageRow(
                    message: "settings.json \(issue). The backend is running on defaults, and changes here are refused until the file is fixed or reset.",
                    style: StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)
                )
                Button("Reset settings to defaults", systemImage: "arrow.counterclockwise", role: .destructive, action: resetSettingsFile)
                    .buttonStyle(.bordered)
            } else if supervisor.hasPendingBackendSettings {
                StatusMessageRow(
                    message: "Saved. The backend applies these on its next launch.",
                    style: StatusStyle(systemImage: "clock.badge.exclamationmark", tint: .orange)
                )
                Button("Restart backend", systemImage: "arrow.clockwise", action: requestRestart)
                    .buttonStyle(.bordered)
                    .restartBackendConfirmation(isPresented: $isConfirmingRestart)
            }
            SettingsCaption(
                text: "These settings live in settings.json under your AgentRoom storage folder, so the backend and paired clients read the same values. Editing them here works whether the backend is running or stopped.",
                systemImage: "doc.badge.gearshape"
            )
        }
    }

    private func resetSettingsFile() {
        supervisor.resetManagedSettingsFile()
    }

    private func requestRestart() {
        isConfirmingRestart = true
    }
}
