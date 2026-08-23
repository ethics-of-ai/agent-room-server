import SwiftUI

struct AdvancedSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var launchAtLoginEnabled = false
    @State private var autoRestartBackendAfterCrash = true
    @State private var terminalEnabled = false
    @State private var sceneEngineEnabled = true
    @State private var remoteSettingsAdminEnabled = false

    var body: some View {
        Form {
            Section("Release Hardening") {
                Toggle("Launch AgentRoom at login", isOn: $launchAtLoginEnabled)
                    .onChange(of: launchAtLoginEnabled) {
                        updateLaunchAtLoginEnabled()
                    }
                Toggle("Auto-restart backend after crash", isOn: $autoRestartBackendAfterCrash)
                    .onChange(of: autoRestartBackendAfterCrash) {
                        updateAutoRestartBackendAfterCrash()
                    }
                SettingsCaption(text: "AgentRoom attempts at most 3 crash restarts in 5 minutes. Upgrade the app before opening data written by a newer version.", systemImage: "shield.checkered")
            }

            Section("Interactive Terminal") {
                Toggle("Enable terminal access from clients", isOn: $terminalEnabled)
                    .disabled(supervisor.isSettingEnvironmentLocked(.terminalEnabled))
                    .onChange(of: terminalEnabled) {
                        updateTerminalEnabled()
                    }
                SettingsCaption(text: "Lets visionOS open an unsandboxed shell inside a registered workspace. The shell has the same filesystem access as your Mac user.", systemImage: "terminal")
                SettingsCaption(text: "Leave this off if anyone you do not trust can reach the backend. The change applies after the next backend restart.")
                ManagedSettingFootnote(key: .terminalEnabled)
            }

            Section("Spatial Scenes") {
                Toggle("Enable spatial scene volumes", isOn: $sceneEngineEnabled)
                    .disabled(supervisor.isSettingEnvironmentLocked(.sceneEngineEnabled))
                    .onChange(of: sceneEngineEnabled) {
                        updateSceneEngineEnabled()
                    }
                SettingsCaption(text: "Lets visionOS render workspace scene and diagram files in 3D. Spatial edits are saved beside the source document through bounded file APIs.", systemImage: "move.3d")
                SettingsCaption(text: "The change applies after the next backend restart.")
                ManagedSettingFootnote(key: .sceneEngineEnabled)
            }

            Section("Remote Settings") {
                Toggle("Allow clients to change trust settings", isOn: $remoteSettingsAdminEnabled)
                    .onChange(of: remoteSettingsAdminEnabled) {
                        updateRemoteSettingsAdmin()
                    }
                SettingsCaption(text: "This lets paired clients change terminal access and runner permission, sandbox, network, and workspace-settings policies. The AgentRoom bearer token authorizes those changes.", systemImage: "lock.shield")
                SettingsCaption(text: "Leave this off to require trust changes on this Mac. The change applies after the next backend restart.")
            }

            ManagedSettingsFileSection()

            Section("Older AgentRoom Compatibility") {
                Button(
                    "Convert settings for an older AgentRoom",
                    systemImage: "arrow.uturn.backward",
                    action: supervisor.writeLegacyManagedSettingsFile
                )
                .buttonStyle(.bordered)
                .disabled(!supervisor.canWriteLegacyManagedSettingsFile)
                SettingsCaption(
                    text: legacyConversionCaption,
                    systemImage: "clock.arrow.circlepath"
                )
            }

            Section("Diagnostics & Resets") {
                Button("Reset local diagnostics", systemImage: "trash", role: .destructive, action: supervisor.resetLocalDiagnostics)
                    .buttonStyle(.bordered)
                SettingsCaption(text: "Clears cached backend snapshots and local app diagnostics. Workspaces, state, and audit files are preserved.")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: loadSettings)
        .onChange(of: supervisor.managedSettings) { _, _ in
            loadManagedSettings()
        }
        .onChange(of: supervisor.backendSettingsMetadata) { _, _ in
            loadManagedSettings()
        }
    }

    /// Describes the conversion in terms of the current file and runner.
    private var legacyConversionCaption: String {
        if supervisor.managedSettingsIssue != nil {
            return "settings.json cannot be read, so there is nothing to convert. Fix or reset it first."
        }
        // Use the connected backend's display name so unknown runners are not
        // presented as a built-in runner.
        if let runnerKind = supervisor.runnerKindBlockingLegacyManagedSettingsFile {
            let displayName = supervisor.runnerCatalog.displayName(for: runnerKind)
            return "The default runner is \(displayName). Older AgentRoom versions do not recognize it and would ignore this settings file. Choose Codex or Claude Code before converting."
        }
        if supervisor.isManagedSettingsFileLegacy {
            return "settings.json is already in the older format. A current AgentRoom converts it back the next time these settings change."
        }
        return "Rewrites settings.json in the flat format an AgentRoom from before the runner-settings change can read, so you can roll back without losing your trust posture. A current AgentRoom converts it forward again on the next change."
    }

    private func loadSettings() {
        launchAtLoginEnabled = supervisor.settings.launchAtLoginEnabled
        autoRestartBackendAfterCrash = supervisor.settings.autoRestartBackendAfterCrash
        remoteSettingsAdminEnabled = supervisor.settings.remoteSettingsAdminEnabled
        loadManagedSettings()
    }

    /// Reloads changes made in the Runner pane, by a paired client, or by reset.
    private func loadManagedSettings() {
        terminalEnabled = supervisor.displayedTerminalEnabled
        sceneEngineEnabled = supervisor.displayedSceneEngineEnabled
    }

    private func updateLaunchAtLoginEnabled() {
        supervisor.updateLaunchAtLogin(launchAtLoginEnabled)
        launchAtLoginEnabled = supervisor.settings.launchAtLoginEnabled
    }

    private func updateAutoRestartBackendAfterCrash() {
        supervisor.updateAutoRestartBackendAfterCrash(autoRestartBackendAfterCrash)
    }

    private func updateTerminalEnabled() {
        guard terminalEnabled != supervisor.displayedTerminalEnabled else { return }
        supervisor.updateTerminalEnabled(terminalEnabled)
    }

    private func updateSceneEngineEnabled() {
        guard sceneEngineEnabled != supervisor.displayedSceneEngineEnabled else { return }
        supervisor.updateSceneEngineEnabled(sceneEngineEnabled)
    }

    private func updateRemoteSettingsAdmin() {
        supervisor.updateRemoteSettingsAdmin(remoteSettingsAdminEnabled)
    }
}
