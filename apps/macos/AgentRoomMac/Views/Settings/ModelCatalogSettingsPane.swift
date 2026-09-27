import SwiftUI

/// Edits the operator's local model catalog, `$AGENTROOM_HOME/config/models.json`.
/// The backend reads it at startup, so a save made while the backend runs
/// offers a restart, the same apply rule as managed settings.
struct ModelCatalogSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var store = ModelCatalogEditorStore()
    @State private var runner = ModelCatalogRunner.codex

    var body: some View {
        Form {
            Section("Model Lists") {
                SettingsCaption(
                    text: "Edit the model lists the runner pickers fall back to. Changes are saved on this Mac and apply when the backend restarts.",
                    systemImage: "list.bullet.rectangle"
                )
                Picker("Runner", selection: $runner) {
                    ForEach(ModelCatalogRunner.allCases, id: \.self) { runner in
                        Text(runner.displayName).tag(runner)
                    }
                }
                .pickerStyle(.segmented)
            }

            if store.isLoaded {
                ModelCatalogModelsSection(store: store, runner: runner)
            }

            ModelCatalogActionsSection(
                store: store,
                runner: runner,
                localFilePath: localFileURL.path,
                save: save,
                revert: revert
            )
        }
        .formStyle(.grouped)
        .task(id: supervisor.settings.agentRoomHomePath) { load() }
        .onChange(of: supervisor.serverState) { _, state in
            if state == .starting {
                store.backendDidRestart()
            }
        }
    }

    private var localFileURL: URL {
        ModelCatalogFileStore.fileURL(forAgentRoomHomePath: supervisor.settings.agentRoomHomePath)
    }

    private var bundledCatalogURL: URL? {
        (try? BackendRuntimeLocator().locateBackendEntrypoint())
            .map(ModelCatalogFileStore.bundledCatalogURL(forBackendEntrypoint:))
    }

    private func load() {
        store.load(bundledCatalogURL: bundledCatalogURL, localFileURL: localFileURL)
    }

    private func save() {
        store.save(backendIsRunning: supervisor.serverState == .running || supervisor.serverState == .externalRunning)
    }

    private func revert() {
        store.revert(bundledCatalogURL: bundledCatalogURL)
    }
}
