import AppKit
import SwiftUI

/// Operator surface for pushing editor language updates to connected Vision Pro
/// editors without an app update. Import copies a catalog folder's
/// data into this Mac's `$AGENTROOM_HOME/catalog-assets`; the backend reloads and
/// broadcasts the change so visionOS re-hydrates live.
struct EditorCatalogSettingsPane: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        Form {
            Section("Editor Languages") {
                SettingsCaption(
                    text: "Push new or updated code-editor languages (TextMate grammars, themes, and VS Code language configs) to connected Vision Pro editors without shipping an app update. Importing copies a catalog folder's data into this Mac's AgentRoom catalog; the backend reloads and visionOS picks it up live.",
                    systemImage: "curlybraces"
                )
            }

            EditorCatalogStatusSection(
                status: supervisor.editorCatalogStatus,
                actionStatus: supervisor.editorCatalogActionStatus
            )

            LanguageServiceStatusSection()

            Section("Actions") {
                Button("Import Catalog Folder…", systemImage: "square.and.arrow.down", action: importCatalog)
                    .buttonStyle(.borderedProminent)
                HStack {
                    Button("Reload", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await supervisor.reloadEditorCatalog() }
                    }
                    Button("Reset to Bundled", systemImage: "arrow.uturn.backward") {
                        Task { await supervisor.resetEditorCatalog() }
                    }
                }
                .buttonStyle(.bordered)
                SettingsCaption(
                    text: "Import accepts a folder shaped like the catalog (EditorGrammars.json at its root, plus grammars/, language-configs/, and vs-textmate/). Only .json and .wasm data is copied — never executable code. The catalog lives at \(supervisor.settings.editorCatalogPath).",
                    systemImage: "folder"
                )
            }
            .disabled(supervisor.isEditorCatalogActionRunning)
        }
        .formStyle(.grouped)
        .task { await supervisor.refreshEditorLanguageStatus() }
    }

    private func importCatalog() {
        guard let url = chooseCatalogDirectory() else { return }
        Task { await supervisor.importEditorCatalog(from: url) }
    }

    private func chooseCatalogDirectory() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Select a catalog folder to import. It must contain EditorGrammars.json at its root."
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        return panel.runModal() == .OK ? panel.url : nil
    }
}
