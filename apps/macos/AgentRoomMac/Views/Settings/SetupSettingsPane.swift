import AppKit
import SwiftUI

struct SetupSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var portText: String = ""
    @State private var storageRootPath: String = ""
    @FocusState private var focusedField: Field?

    private enum Field {
        case port
        case storageRoot
    }

    var body: some View {
        Form {
            Section("First-Run Setup") {
                TextField("Port", text: $portText)
                    .focused($focusedField, equals: .port)
                    .onSubmit(savePort)
                if let portWarning {
                    Label(portWarning, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                SettingsCaption(text: "The backend defaults to port 8787 and binds to 0.0.0.0 for LAN clients.")
            }

            Section("visionOS Pairing Help") {
                SettingsCaption(text: "Keep the simulator set to http://localhost:8787 unless you changed the backend port.")
                SettingsCaption(text: "Use the Mac hostname URL or LAN IP URL for a physical Vision Pro on the same network.", systemImage: "visionpro")
            }

            Section("Workspaces") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Default workspace root")
                            .font(.callout.weight(.medium))
                        Text(supervisor.settings.workspacePath)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                    }
                    Button("Add Another Workspace", systemImage: "folder.badge.plus", action: chooseWorkspaceDirectories)
                        .buttonStyle(.borderedProminent)
                }
                SettingsCaption(text: "Register multiple local folders here. Removing one only deletes AgentRoom registry metadata, not the folder.", systemImage: "folder.badge.plus")
                if let snapshot = supervisor.workspaceSnapshot, !snapshot.workspaces.isEmpty {
                    ForEach(snapshot.workspaces) { workspace in
                        WorkspaceSettingsRow(workspace: workspace)
                    }
                } else {
                    SettingsCaption(text: "Start the backend, then add one or more folders for coding-agent sessions.", systemImage: "folder")
                }
                SettingsCaption(text: "AgentRoom stores workspace registry metadata in app state. It does not write .agentroom files into selected folders.", systemImage: "lock.shield")
            }

            Section("Storage") {
                HStack {
                    TextField("Storage root", text: $storageRootPath)
                        .focused($focusedField, equals: .storageRoot)
                        .onSubmit(saveStorageRootPath)
                    Button("Choose Storage Root", systemImage: "externaldrive", action: chooseStorageRoot)
                        .buttonStyle(.bordered)
                }
                SettingsCaption(text: "State is initialized under the storage root on backend launch.", systemImage: "externaldrive.fill")
                SettingsCaption(text: "Default workspace root: \(supervisor.settings.workspacePath)", systemImage: "folder")
                SettingsCaption(text: "State path: \(supervisor.settings.statePath)", systemImage: "doc.text")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: loadSettings)
        .onChange(of: focusedField) { previous, _ in
            commit(previous)
        }
    }

    private func commit(_ field: Field?) {
        switch field {
        case .port:
            savePort()
        case .storageRoot:
            saveStorageRootPath()
        case nil:
            break
        }
    }

    private func loadSettings() {
        portText = String(supervisor.settings.serverPort)
        storageRootPath = supervisor.settings.agentRoomHomePath
        Task { await supervisor.refreshWorkspaces() }
    }

    private var portWarning: String? {
        let trimmed = portText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        guard let port = Int(trimmed), (1...65535).contains(port) else {
            return "Enter a port number between 1 and 65535."
        }
        return nil
    }

    private func savePort() {
        let trimmed = portText.trimmingCharacters(in: .whitespaces)
        guard let port = Int(trimmed), (1...65535).contains(port), port != supervisor.settings.serverPort else {
            return
        }
        supervisor.updateServerPort(port)
    }

    private func saveStorageRootPath() {
        let expanded = NSString(string: storageRootPath.trimmingCharacters(in: .whitespacesAndNewlines)).expandingTildeInPath
        guard !expanded.isEmpty, expanded != supervisor.settings.agentRoomHomePath else {
            storageRootPath = supervisor.settings.agentRoomHomePath
            return
        }
        supervisor.updateStorageRootPath(storageRootPath)
        storageRootPath = supervisor.settings.agentRoomHomePath
    }

    private func chooseStorageRoot() {
        guard let url = chooseDirectory(message: "Select where AgentRoom should store local state and app configuration.") else {
            return
        }
        storageRootPath = url.path
        saveStorageRootPath()
    }

    private func chooseWorkspaceDirectories() {
        let panel = NSOpenPanel()
        panel.message = "Select one or more folders AgentRoom can use for coding-agent sessions."
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK else {
            return
        }
        let urls = panel.urls
        Task {
            for url in urls {
                await supervisor.registerWorkspace(path: url.path)
            }
        }
    }

    private func chooseDirectory(message: String) -> URL? {
        let panel = NSOpenPanel()
        panel.message = message
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }
}
