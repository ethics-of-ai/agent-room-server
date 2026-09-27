import SwiftUI

struct DeepSeekCatalogModelRow: View {
    @Binding var model: DeepSeekCatalogModel
    var store: ModelCatalogEditorStore
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            TextField("ID", text: $model.id, prompt: Text("deepseek-flash"))
            TextField("Name", text: $model.label)
            TextField("Description", text: $model.description, axis: .vertical)
            ModelCatalogRowActions(store: store, runner: .deepseek, rowID: model.rowID)
        } label: {
            ModelCatalogRowLabel(label: model.label, id: model.id)
        }
        .onAppear(perform: expandIfNew)
    }

    private func expandIfNew() {
        if model.id.isEmpty {
            isExpanded = true
        }
    }
}
