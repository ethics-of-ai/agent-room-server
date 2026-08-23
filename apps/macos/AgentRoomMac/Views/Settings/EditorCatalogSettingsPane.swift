import AppKit
import SwiftUI

/// Operator surface for pushing editor language updates to connected Vision Pro
/// editors without an app update (Phase C.5). Import copies a catalog folder's
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

            Section("Status") {
                if let status = supervisor.editorCatalogStatus {
                    LabeledContent("Serving", value: sourceLabel(status.source))
                    LabeledContent("Languages", value: "\(status.languageCount)")
                    if let version = status.version {
                        LabeledContent("Version", value: String(version.prefix(12)))
                    }
                } else {
                    SettingsCaption(text: "Start the backend to load editor catalog status.", systemImage: "questionmark.circle")
                }
                if let action = supervisor.editorCatalogActionStatus {
                    StatusMessageRow(message: action.message, style: action.style)
                }
            }

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
        }
        .formStyle(.grouped)
        .task { await supervisor.refreshEditorCatalogStatus() }
    }

    private func sourceLabel(_ source: EditorCatalogSource) -> String {
        switch source {
        case .overrideDir: "Imported catalog (this Mac)"
        case .bundled: "Bundled catalog (built-in)"
        case .none: "No catalog"
        }
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
