import Foundation

struct SanitizedSettings: Codable, Equatable {
    var serverPort: Int
    var workspacePath: String
    var statePath: String
    var agentRoomHomePath: String
    var launchAtLoginEnabled: Bool
    var autoRestartBackendAfterCrash: Bool
    var remoteSettingsAdminEnabled: Bool
    /// The backend's managed settings as this app last read them. Safe to export:
    /// tier 3 — the auth token, executable paths, `TERMINAL_SHELL`, host/port and
    /// the storage directories — is excluded from the managed set by construction,
    /// so this block cannot carry a secret. Absent keys mean "backend default".
    var managedSettings: ManagedBackendSettings

    init(settings: AppSettings, managedSettings: ManagedBackendSettings) {
        self.serverPort = settings.serverPort
        self.workspacePath = settings.workspacePath
        self.statePath = settings.statePath
        self.agentRoomHomePath = settings.agentRoomHomePath
        self.launchAtLoginEnabled = settings.launchAtLoginEnabled
        self.autoRestartBackendAfterCrash = settings.autoRestartBackendAfterCrash
        self.remoteSettingsAdminEnabled = settings.remoteSettingsAdminEnabled
        self.managedSettings = managedSettings
    }
}
