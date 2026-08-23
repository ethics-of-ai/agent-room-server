import SwiftUI

struct CredentialsSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var authToken = ""
    @State private var isAuthTokenVisible = false
    @State private var authTokenMessage: String?

    var body: some View {
        Form {
            Section("AgentRoom Auth Token") {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if isAuthTokenVisible {
                        TextField("Bearer token", text: $authToken)
                            .font(.system(.body, design: .monospaced))
                    } else {
                        SecureField("Bearer token", text: $authToken)
                    }
                    Button(
                        isAuthTokenVisible ? "Hide token" : "Show token",
                        systemImage: isAuthTokenVisible ? "eye.slash" : "eye",
                        action: toggleTokenVisibility
                    )
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help(isAuthTokenVisible ? "Hide token" : "Show token")
                    CopyButton(value: trimmedAuthToken, title: "Copy token", isEnabled: !trimmedAuthToken.isEmpty)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                HStack {
                    Button("Generate Token", systemImage: "key.fill", action: generateToken)
                        .buttonStyle(.bordered)
                    Spacer()
                    Text("Use when pairing visionOS clients over LAN.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let authTokenMessage {
                    SettingsCaption(text: authTokenMessage, systemImage: "info.circle")
                }
                SettingsCaption(text: "Stored in macOS Keychain and injected into the backend process environment at launch.", systemImage: "key.viewfinder")
            }

            Section {
                HStack(spacing: DashboardTheme.elementSpacing) {
                    Button("Check Backend", systemImage: "checkmark.seal", action: saveAndRefresh)
                        .buttonStyle(.bordered)

                    Spacer()

                    Button("Save", action: save)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
        .onDisappear(perform: clearSensitiveState)
    }

    private var trimmedAuthToken: String {
        authToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func generateToken() {
        authToken = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        Clipboard.copy(authToken)
        authTokenMessage = "Generated token and copied it to the clipboard. Save to apply it."
    }

    private func toggleTokenVisibility() {
        isAuthTokenVisible.toggle()
        authTokenMessage = isAuthTokenVisible ? "Token is visible." : nil
    }

    private func saveAndRefresh() {
        save()
        Task { await supervisor.refreshConnectionStatus() }
    }

    private func load() {
        authToken = supervisor.secrets.authToken ?? ""
        authTokenMessage = nil
    }

    /// Drop the cleartext token and reset reveal state when the pane goes away,
    /// so the secret does not linger visible or in view memory between visits.
    private func clearSensitiveState() {
        authToken = ""
        isAuthTokenVisible = false
        authTokenMessage = nil
    }

    private func save() {
        // Edit the stored blob rather than rebuilding it: with runner bootstrap
        // values in a keyed dictionary, a memberwise rebuild that forgot one
        // would have cleared it.
        var updated = supervisor.secrets
        updated.authToken = authToken
        supervisor.updateBackendSecrets(updated)
    }
}
