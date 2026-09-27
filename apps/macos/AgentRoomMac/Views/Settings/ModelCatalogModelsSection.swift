import SwiftUI

/// The selected runner's model rows.
struct ModelCatalogModelsSection: View {
    @Bindable var store: ModelCatalogEditorStore
    var runner: ModelCatalogRunner

    var body: some View {
        Section {
            switch runner {
            case .claudeCode:
                let vocabulary = store.claudeCode.reasoningEfforts
                ForEach($store.claudeCode.fallbackModels, id: \.rowID) { $model in
                    ClaudeCodeCatalogModelRow(model: $model, vocabulary: vocabulary, store: store)
                }
            case .cursor:
                ForEach($store.cursor.fallbackModels, id: \.rowID) { $model in
                    CursorCatalogModelRow(model: $model, store: store)
                }
            case .deepseek:
                ForEach($store.deepseek.models, id: \.rowID) { $model in
                    DeepSeekCatalogModelRow(model: $model, store: store)
                }
            }
            Button("Add Model", systemImage: "plus", action: addModel)
        } header: {
            Text("\(runner.displayName) Models")
        } footer: {
            SettingsCaption(text: runner.listSummary)
        }
    }

    private func addModel() {
        store.addModel(to: runner)
    }
}
