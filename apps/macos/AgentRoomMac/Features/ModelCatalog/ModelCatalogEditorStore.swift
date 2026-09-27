import Foundation
import Observation

/// Editing state for the Models settings pane.
///
/// Each section starts from the local copy when it lists that runner and from
/// the bundled catalog otherwise. Saving writes only the sections that differ
/// from the bundled catalog, so a runner the operator never changed keeps
/// receiving bundled updates. A section edited back to match the bundled one is
/// dropped from the local copy for the same reason.
@MainActor
@Observable
final class ModelCatalogEditorStore {
    var codex = CodexModelCatalog(fallbackModels: [])
    var claudeCode = ClaudeCodeModelCatalog(reasoningEfforts: [], fallbackModels: [])
    var cursor = CursorModelCatalog(fallbackModels: [])
    var deepseek = DeepSeekModelCatalog(models: [])

    /// Why the pane cannot edit at all: the bundled catalog was not found.
    private(set) var loadIssue: String?
    /// Why the existing local copy was not used. Saving replaces it.
    private(set) var localFileIssue: String?
    private(set) var saveIssue: String?
    /// Saved while the backend was running, so the backend has not applied it yet.
    private(set) var isAwaitingRestart = false

    private var bundled: ModelCatalogDocument.Runners?
    private var saved = ModelCatalogDocument.Runners()
    private var fileURL: URL?
    private let fileStore: ModelCatalogFileStore

    init(fileStore: ModelCatalogFileStore = ModelCatalogFileStore()) {
        self.fileStore = fileStore
    }

    var isLoaded: Bool { bundled != nil }

    var issues: [String] { ModelCatalogValidator.issues(in: normalized) }

    var hasUnsavedChanges: Bool { isLoaded && normalized != saved }

    /// Also true for an unchanged form over an invalid local copy, so saving can replace it.
    var canSave: Bool { isLoaded && issues.isEmpty && (hasUnsavedChanges || localFileIssue != nil) }

    func isCustomized(_ runner: ModelCatalogRunner) -> Bool {
        switch runner {
        case .codex: normalized.codex != nil
        case .claudeCode: normalized.claudeCode != nil
        case .cursor: normalized.cursor != nil
        case .deepseek: normalized.deepseek != nil
        }
    }

    func load(bundledCatalogURL: URL?, localFileURL: URL) {
        fileURL = localFileURL
        saveIssue = nil
        guard let bundledCatalogURL,
              let document = try? fileStore.read(at: bundledCatalogURL),
              let codex = document.runners.codex,
              let claudeCode = document.runners.claudeCode,
              let cursor = document.runners.cursor,
              let deepseek = document.runners.deepseek else {
            bundled = nil
            loadIssue = "The backend's bundled model catalog was not found, so there is nothing to edit. Build or reinstall the backend."
            return
        }
        loadIssue = nil
        bundled = document.runners

        var local = ModelCatalogDocument.Runners()
        do {
            local = try fileStore.read(at: localFileURL)?.runners ?? local
            localFileIssue = nil
        } catch {
            localFileIssue = "models.json \(error.localizedDescription). The backend ignores it and uses the bundled catalog. Saving replaces it."
        }
        self.codex = local.codex ?? codex
        self.claudeCode = local.claudeCode ?? claudeCode
        self.cursor = local.cursor ?? cursor
        self.deepseek = local.deepseek ?? deepseek
        saved = localFileIssue == nil ? normalized : ModelCatalogDocument.Runners()
    }

    func save(backendIsRunning: Bool) {
        guard let fileURL, canSave else { return }
        let runners = normalized
        do {
            try fileStore.write(runners, to: fileURL)
            saved = runners
            localFileIssue = nil
            saveIssue = nil
            if backendIsRunning {
                isAwaitingRestart = true
            }
        } catch {
            saveIssue = "Could not save models.json: \(error.localizedDescription)"
        }
    }

    /// Discards unsaved edits by reading both files again.
    func revert(bundledCatalogURL: URL?) {
        guard let fileURL else { return }
        load(bundledCatalogURL: bundledCatalogURL, localFileURL: fileURL)
    }

    /// Replaces one section with the bundled one. Takes effect on save.
    func resetToBundled(_ runner: ModelCatalogRunner) {
        guard let bundled else { return }
        switch runner {
        case .codex: bundled.codex.map { codex = $0 }
        case .claudeCode: bundled.claudeCode.map { claudeCode = $0 }
        case .cursor: bundled.cursor.map { cursor = $0 }
        case .deepseek: bundled.deepseek.map { deepseek = $0 }
        }
    }

    /// The backend has restarted, so it now runs the saved copy.
    func backendDidRestart() {
        isAwaitingRestart = false
    }

    func addModel(to runner: ModelCatalogRunner) {
        switch runner {
        case .codex: codex.fallbackModels.append(CodexCatalogModel(id: "", label: ""))
        case .claudeCode: claudeCode.fallbackModels.append(ClaudeCodeCatalogModel(id: "", label: ""))
        case .cursor: cursor.fallbackModels.append(CursorCatalogModel(id: "", label: ""))
        case .deepseek: deepseek.models.append(DeepSeekCatalogModel(id: "", label: ""))
        }
    }

    func removeModel(_ rowID: UUID, from runner: ModelCatalogRunner) {
        switch runner {
        case .codex: codex.fallbackModels.removeAll { $0.rowID == rowID }
        case .claudeCode: claudeCode.fallbackModels.removeAll { $0.rowID == rowID }
        case .cursor: cursor.fallbackModels.removeAll { $0.rowID == rowID }
        case .deepseek: deepseek.models.removeAll { $0.rowID == rowID }
        }
    }

    /// Moves a row up (`offset` -1) or down (`offset` 1). Order matters: the
    /// first Claude Code model is the fallback default.
    func moveModel(_ rowID: UUID, by offset: Int, in runner: ModelCatalogRunner) {
        switch runner {
        case .codex: Self.move(rowID, by: offset, in: &codex.fallbackModels)
        case .claudeCode: Self.move(rowID, by: offset, in: &claudeCode.fallbackModels)
        case .cursor: Self.move(rowID, by: offset, in: &cursor.fallbackModels)
        case .deepseek: Self.move(rowID, by: offset, in: &deepseek.models)
        }
    }

    func canMoveModel(_ rowID: UUID, by offset: Int, in runner: ModelCatalogRunner) -> Bool {
        let rowIDs: [UUID] = switch runner {
        case .codex: codex.fallbackModels.map(\.rowID)
        case .claudeCode: claudeCode.fallbackModels.map(\.rowID)
        case .cursor: cursor.fallbackModels.map(\.rowID)
        case .deepseek: deepseek.models.map(\.rowID)
        }
        guard let index = rowIDs.firstIndex(of: rowID) else { return false }
        return rowIDs.indices.contains(index + offset)
    }

    /// Makes one Cursor model the default and clears the flag on the others.
    func makeCursorDefault(_ rowID: UUID) {
        for index in cursor.fallbackModels.indices {
            cursor.fallbackModels[index].isDefault = cursor.fallbackModels[index].rowID == rowID
        }
    }

    /// Makes one Codex model the default and clears the flag on the others.
    func makeCodexDefault(_ rowID: UUID) {
        for index in codex.fallbackModels.indices {
            codex.fallbackModels[index].isDefault = codex.fallbackModels[index].rowID == rowID
        }
    }

    /// The sections that differ from the bundled catalog, trimmed the way the
    /// backend's schema trims them, so they are what a save would write.
    private var normalized: ModelCatalogDocument.Runners {
        let codex = Self.normalized(codex)
        let claudeCode = Self.normalized(claudeCode)
        let cursor = Self.normalized(cursor)
        let deepseek = Self.normalized(deepseek)
        return ModelCatalogDocument.Runners(
            codex: codex == bundled?.codex ? nil : codex,
            claudeCode: claudeCode == bundled?.claudeCode ? nil : claudeCode,
            cursor: cursor == bundled?.cursor ? nil : cursor,
            deepseek: deepseek == bundled?.deepseek ? nil : deepseek
        )
    }

    private static func normalized(_ catalog: CodexModelCatalog) -> CodexModelCatalog {
        var catalog = catalog
        for index in catalog.fallbackModels.indices {
            var model = catalog.fallbackModels[index]
            model.id = trimmed(model.id)
            model.label = trimmed(model.label)
            model.description = trimmed(model.description)
            model.efforts = model.efforts.map(trimmed).filter { !$0.isEmpty }
            catalog.fallbackModels[index] = model
        }
        return catalog
    }

    private static func normalized(_ catalog: ClaudeCodeModelCatalog) -> ClaudeCodeModelCatalog {
        var catalog = catalog
        for index in catalog.fallbackModels.indices {
            catalog.fallbackModels[index].id = trimmed(catalog.fallbackModels[index].id)
            catalog.fallbackModels[index].label = trimmed(catalog.fallbackModels[index].label)
            catalog.fallbackModels[index].description = trimmed(catalog.fallbackModels[index].description)
        }
        return catalog
    }

    private static func normalized(_ catalog: CursorModelCatalog) -> CursorModelCatalog {
        var catalog = catalog
        for index in catalog.fallbackModels.indices {
            var model = catalog.fallbackModels[index]
            model.id = trimmed(model.id)
            model.label = trimmed(model.label)
            model.description = trimmed(model.description)
            let values = model.depthValues.map(trimmed).filter { !$0.isEmpty }
            model.depth?.values = values
            catalog.fallbackModels[index] = model
        }
        return catalog
    }

    private static func normalized(_ catalog: DeepSeekModelCatalog) -> DeepSeekModelCatalog {
        var catalog = catalog
        for index in catalog.models.indices {
            catalog.models[index].id = trimmed(catalog.models[index].id)
            catalog.models[index].label = trimmed(catalog.models[index].label)
            catalog.models[index].description = trimmed(catalog.models[index].description)
        }
        return catalog
    }

    private static func move<Row: ModelCatalogRow>(_ rowID: UUID, by offset: Int, in rows: inout [Row]) {
        guard let index = rows.firstIndex(where: { $0.rowID == rowID }),
              rows.indices.contains(index + offset) else { return }
        rows.swapAt(index, index + offset)
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
