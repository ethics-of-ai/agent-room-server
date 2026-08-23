import SwiftUI

/// The per-key footnote under a managed settings control: whether an environment
/// variable has locked the key, or what a backend restart would change it to.
///
/// It renders nothing when neither applies, and nothing at all while the backend
/// is unreachable — provenance describes a running process, so an unreachable
/// backend means "not knowable yet" rather than "nothing to say".
struct ManagedSettingFootnote: View {
    @Environment(BackendSupervisor.self) private var supervisor
    var key: ManagedBackendSettingKey

    var body: some View {
        if let status = supervisor.settingStatus(for: key) {
            if status.isEnvironmentLocked {
                SettingsCaption(
                    text: "Locked by an environment variable on this Mac, so the backend ignores the settings file for this one.",
                    systemImage: "lock"
                )
            } else if let pending = status.pendingDescription {
                SettingsCaption(
                    text: "Restart the backend to apply: \(pending).",
                    systemImage: "arrow.clockwise"
                )
            }
        }
    }
}
