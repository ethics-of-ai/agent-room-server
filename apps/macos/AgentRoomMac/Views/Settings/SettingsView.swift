import SwiftUI

struct SettingsView: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @State private var selection: SettingsSection = .setup
    @State private var modelCatalogStore = ModelCatalogEditorStore()

    var body: some View {
        NavigationSplitView {
            List(SettingsSection.allCases, selection: $selection) { section in
                Label(section.title, systemImage: section.systemImage)
                    .tag(section)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        } detail: {
            SettingsPaneContent(section: selection)
                .environment(modelCatalogStore)
                .navigationTitle(selection.title)
        }
        .background(SettingsWindowToolbar())
        .frame(minWidth: 720, minHeight: 560)
        .task(id: supervisor.settings.agentRoomHomePath) { loadModelCatalog() }
        .onChange(of: supervisor.serverState) { _, state in
            if state == .starting { modelCatalogStore.backendDidRestart() }
        }
    }

    private func loadModelCatalog() {
        let bundledURL = (try? BackendRuntimeLocator().locateBackendEntrypoint())
            .map(ModelCatalogFileStore.bundledCatalogURL(forBackendEntrypoint:))
        modelCatalogStore.load(
            bundledCatalogURL: bundledURL,
            localFileURL: ModelCatalogFileStore.fileURL(forAgentRoomHomePath: supervisor.settings.agentRoomHomePath)
        )
    }
}
