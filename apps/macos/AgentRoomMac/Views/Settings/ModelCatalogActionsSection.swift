import SwiftUI

/// Problems, save state, and the save, revert, and reset actions.
struct ModelCatalogActionsSection: View {
    var store: ModelCatalogEditorStore
    var runner: ModelCatalogRunner
    var localFilePath: String
    var save: () -> Void
    var revert: () -> Void
    @State private var isConfirmingRestart = false

    private static let warning = StatusStyle(systemImage: "exclamationmark.triangle.fill", tint: .orange)

    var body: some View {
        Section("Save") {
            if let loadIssue = store.loadIssue {
                StatusMessageRow(message: loadIssue, style: Self.warning)
            }
            if let localFileIssue = store.localFileIssue {
                StatusMessageRow(message: localFileIssue, style: Self.warning)
            }
            ForEach(store.issues, id: \.self) { issue in
                StatusMessageRow(message: issue, style: Self.warning)
            }
            if let saveIssue = store.saveIssue {
                StatusMessageRow(message: saveIssue, style: Self.warning)
            }
            if store.isAwaitingRestart && !store.hasUnsavedChanges {
                StatusMessageRow(
                    message: "Saved. The backend applies these on its next launch.",
                    style: StatusStyle(systemImage: "clock.badge.exclamationmark", tint: .orange)
                )
                Button("Restart backend", systemImage: "arrow.clockwise", action: requestRestart)
                    .buttonStyle(.bordered)
                    .restartBackendConfirmation(isPresented: $isConfirmingRestart)
            }

            HStack {
                Button("Save", systemImage: "square.and.arrow.down", action: save)
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.canSave)
                Button("Revert", systemImage: "arrow.uturn.backward", action: revert)
                    .disabled(!store.hasUnsavedChanges)
                Button("Use Bundled \(runner.displayName) List", systemImage: "shippingbox", action: resetRunner)
                    .disabled(!store.isCustomized(runner))
            }
            .buttonStyle(.bordered)
            .disabled(!store.isLoaded)

            SettingsCaption(
                text: "Saved to \(localFilePath). Only runners you change are written there; the others keep the list that ships with the app, including its updates.",
                systemImage: "doc.badge.gearshape"
            )
        }
    }

    private func resetRunner() {
        store.resetToBundled(runner)
    }

    private func requestRestart() {
        isConfirmingRestart = true
    }
}
