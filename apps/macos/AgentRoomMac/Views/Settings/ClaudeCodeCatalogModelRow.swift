import SwiftUI

struct ClaudeCodeCatalogModelRow: View {
    @Binding var model: ClaudeCodeCatalogModel
    var vocabulary: [ModelCatalogEffortLevel]
    var store: ModelCatalogEditorStore
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            TextField("ID", text: $model.id, prompt: Text("opus"))
            TextField("Name", text: $model.label)
            TextField("Description", text: $model.description, axis: .vertical)
            LabeledContent("Effort levels") {
                HStack {
                    ForEach(vocabulary, id: \.id) { level in
                        Toggle(level.label, isOn: $model[effort: level.id, vocabulary: vocabularyIDs])
                            .toggleStyle(.checkbox)
                    }
                }
            }
            ModelCatalogRowActions(store: store, runner: .claudeCode, rowID: model.rowID)
        } label: {
            ModelCatalogRowLabel(label: model.label, id: model.id)
        }
        .onAppear(perform: expandIfNew)
    }

    private var vocabularyIDs: [String] {
        vocabulary.map(\.id)
    }

    private func expandIfNew() {
        if model.id.isEmpty {
            isExpanded = true
        }
    }
}
