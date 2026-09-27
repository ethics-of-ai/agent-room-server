import SwiftUI

/// Move and remove controls shared by every model row.
struct ModelCatalogRowActions: View {
    var store: ModelCatalogEditorStore
    var runner: ModelCatalogRunner
    var rowID: UUID

    var body: some View {
        HStack {
            Button("Move Up", systemImage: "arrow.up", action: moveUp)
                .disabled(!store.canMoveModel(rowID, by: -1, in: runner))
            Button("Move Down", systemImage: "arrow.down", action: moveDown)
                .disabled(!store.canMoveModel(rowID, by: 1, in: runner))
            Spacer()
            Button("Remove", systemImage: "trash", role: .destructive, action: remove)
        }
        .buttonStyle(.borderless)
    }

    private func moveUp() {
        store.moveModel(rowID, by: -1, in: runner)
    }

    private func moveDown() {
        store.moveModel(rowID, by: 1, in: runner)
    }

    private func remove() {
        store.removeModel(rowID, from: runner)
    }
}
