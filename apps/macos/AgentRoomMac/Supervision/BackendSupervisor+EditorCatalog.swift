import Foundation

extension BackendSupervisor {
    var isEditorCatalogActionRunning: Bool {
        if case .working = editorCatalogActionStatus { return true }
        return false
    }

    /// Refresh the operator-facing catalog status for the Languages settings pane.
    func refreshEditorCatalogStatus() async {
        do {
            editorCatalogStatus = try await currentAPIClient().fetchEditorCatalogStatus()
        } catch {
            editorCatalogStatus = nil
            appendDiagnostic("warning", "Could not load editor catalog status: \(error.localizedDescription)")
        }
    }

    /// Stage a catalog beside the app-managed override, activate it by directory
    /// rename, and keep it only after the backend accepts the complete snapshot.
    func importEditorCatalog(from sourceURL: URL) async {
        guard !isEditorCatalogActionRunning else { return }
        editorCatalogActionStatus = .working("Importing catalog…")
        let apiClient = currentAPIClient()
        var transaction: EditorCatalogImporter.Transaction?
        do {
            let destinationPath = settings.editorCatalogPath
            let staged = try await Task.detached(priority: .userInitiated) {
                try EditorCatalogImporter().stageCatalog(from: sourceURL, into: destinationPath)
            }.value
            transaction = staged
            try await Task.detached(priority: .userInitiated) { try staged.activate() }.value
            let result = try await apiClient.reloadEditorCatalog()
            guard result.accepted else {
                try await Task.detached(priority: .userInitiated) { try staged.rollback() }.value
                _ = try? await apiClient.reloadEditorCatalog()
                await refreshEditorCatalogStatus()
                let code = result.validation.code ?? "catalog_invalid"
                editorCatalogActionStatus = .failure("Catalog rejected (\(code)); the previous override was restored.")
                appendDiagnostic("warning", "Rejected editor catalog import (\(code)); restored the previous override.")
                return
            }
            try await Task.detached(priority: .userInitiated) { try staged.commit() }.value
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = .success("Imported \(staged.summary.fileCount) files. Backend serving the \(result.source.rawValue) catalog.")
            appendDiagnostic("info", "Imported editor catalog (\(staged.summary.fileCount) files); backend now serving \(result.source.rawValue).")
        } catch {
            if let transaction {
                try? await Task.detached(priority: .userInitiated) { try transaction.rollback() }.value
                _ = try? await apiClient.reloadEditorCatalog()
            }
            editorCatalogActionStatus = .failure("Import failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to import editor catalog: \(error.localizedDescription)")
        }
    }

    func reloadEditorCatalog() async {
        guard !isEditorCatalogActionRunning else { return }
        editorCatalogActionStatus = .working("Reloading catalog…")
        do {
            let result = try await currentAPIClient().reloadEditorCatalog()
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = result.accepted
                ? .success(result.changed ? "Reloaded; catalog updated." : "Reloaded; no changes.")
                : .failure("Catalog rejected; the previous generation remains active.")
            appendDiagnostic("info", "Reloaded editor catalog (changed: \(result.changed), source: \(result.source.rawValue)).")
        } catch {
            editorCatalogActionStatus = .failure("Reload failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to reload editor catalog: \(error.localizedDescription)")
        }
    }

    func resetEditorCatalog() async {
        guard !isEditorCatalogActionRunning else { return }
        editorCatalogActionStatus = .working("Resetting to bundled…")
        do {
            try EditorCatalogImporter().reset(settings.editorCatalogPath)
            let result = try await currentAPIClient().reloadEditorCatalog()
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = .success("Reset to the \(result.source.rawValue) catalog.")
            appendDiagnostic("info", "Reset editor catalog override; backend now serving \(result.source.rawValue).")
        } catch {
            editorCatalogActionStatus = .failure("Reset failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to reset editor catalog: \(error.localizedDescription)")
        }
    }
}
