import SwiftUI

struct RunnerSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var runnerKind = ManagedBackendSettings.defaultRunnerKind
    @State private var codexReasoningEffort = ""
    @State private var codexWorkspaceNetworkAccessEnabled = false

    var body: some View {
        Form {
            Section("Default Runner") {
                // The runners the backend registers, not a list compiled in here.
                // `includingSelection` keeps a value the file already holds on the
                // menu even when the catalog does not list it. While the backend
                // is stopped the floor is all this app has, and a picker that
                // silently dropped the operator's own setting would rewrite it on
                // the next change.
                Picker("Default runner", selection: $runnerKind) {
                    ForEach(supervisor.runnerCatalog.includingSelection(runnerKind)) { runner in
                        Text(runner.displayName).tag(runner.runnerKind)
                    }
                }
                .disabled(supervisor.isSettingEnvironmentLocked(.runnerKind))
                .onChange(of: runnerKind) { _, newValue in
                    guard newValue != supervisor.displayedRunnerKind else { return }
                    supervisor.updateRunnerKind(newValue)
                }
                SettingsCaption(text: "New sessions use this runner unless a client chooses another. The change applies after the next backend restart.", systemImage: "cpu")
                SettingsCaption(text: "Claude Code uses the Mac user's Claude login. Review its permission mode before using an unfamiliar workspace.")
                ManagedSettingFootnote(key: .runnerKind)
            }

            // The public catalog supplies runner identity and runtime status.
            // Bundled descriptors supply trusted local bootstrap controls.
            ForEach(supervisor.runnerSettingsDescriptors) { runner in
                RunnerBootstrapSection(
                    runner: runner,
                    descriptor: supervisor.runnerBootstrapDescriptor(for: runner.runnerKind)
                )
            }
            Section {
                SettingsCaption(text: "Executable paths and arguments stay in Keychain and apply after the next backend restart.", systemImage: "terminal")
                SettingsCaption(text: "Claude Code can use a local CLI or the version bundled with its SDK. That CLI determines which models the picker offers.")
                SettingsCaption(text: "Setup checks inspect this Mac and work while the backend is stopped. Runtime status appears above after the backend probes a runner.", systemImage: "stethoscope")
            }

            Section("Codex Defaults") {
                Picker("Reasoning effort", selection: $codexReasoningEffort) {
                    Text("Backend default").tag("")
                    ForEach(ManagedBackendSettings.reasoningEffortValues, id: \.self) { effort in
                        Text(effort.capitalized).tag(effort)
                    }
                }
                .disabled(supervisor.isSettingEnvironmentLocked(.codexReasoningEffort))
                .onChange(of: codexReasoningEffort) { _, newValue in
                    guard newValue != (supervisor.displayedCodexReasoningEffort ?? "") else { return }
                    supervisor.updateCodexReasoningEffort(newValue.isEmpty ? nil : newValue)
                }
                ManagedSettingFootnote(key: .codexReasoningEffort)
                SettingsCaption(text: "Lives in the shared backend settings file, so paired clients can read and change it. Applies on the next backend launch.", systemImage: "gauge.with.dots.needle.33percent")
            }

            Section("Git Network Access") {
                Toggle("Allow fetch, pull, and push", isOn: $codexWorkspaceNetworkAccessEnabled)
                    .disabled(isGitNetworkAccessLocked)
                    .onChange(of: codexWorkspaceNetworkAccessEnabled) { _, newValue in
                        guard newValue != supervisor.displayedCodexWorkspaceNetworkAccess else { return }
                        supervisor.updateCodexWorkspaceNetworkAccess(newValue)
                    }
                SettingsCaption(text: "Applies to future backend launches. Enable only for trusted workspaces when Codex needs to write Git metadata and reach remotes through your local SSH agent or Git credential helper.", systemImage: "network")
                // One control, two settings: Codex cannot write .git metadata
                // under workspace-write, so the sandbox mode travels with the
                // network toggle and either key being locked freezes the pair.
                ManagedSettingFootnote(key: .codexWorkspaceNetworkAccess)
                ManagedSettingFootnote(key: .codexSandboxMode)
            }

            // Everything above is a setting this build compiled in. A runner the
            // backend registers brings its own, and they are in the same file.
            // Those settings are shown rather than silently carried.
            PreservedSettingsSection()

            ManagedSettingsFileSection()
        }
        .formStyle(.grouped)
        .onAppear(perform: loadManagedSettings)
        .onChange(of: supervisor.managedSettings) { _, _ in
            loadManagedSettings()
        }
        .onChange(of: supervisor.backendSettingsMetadata) { _, _ in
            loadManagedSettings()
        }
    }

    /// Locks the paired settings when the environment controls either value.
    private var isGitNetworkAccessLocked: Bool {
        supervisor.isSettingEnvironmentLocked(.codexWorkspaceNetworkAccess)
            || supervisor.isSettingEnvironmentLocked(.codexSandboxMode)
    }

    /// Reloads changes made in Advanced, by a paired client, or by reset.
    private func loadManagedSettings() {
        runnerKind = supervisor.displayedRunnerKind
        codexReasoningEffort = supervisor.displayedCodexReasoningEffort ?? ""
        codexWorkspaceNetworkAccessEnabled = supervisor.displayedCodexWorkspaceNetworkAccess
    }
}
