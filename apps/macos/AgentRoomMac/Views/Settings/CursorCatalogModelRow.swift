import SwiftUI

struct CursorCatalogModelRow: View {
    @Binding var model: CursorCatalogModel
    var store: ModelCatalogEditorStore
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            TextField("ID", text: $model.id, prompt: Text("claude-sonnet-5"))
            TextField("Name", text: $model.label)
            TextField("Description", text: $model.description, axis: .vertical)
            TextField("Context window (tokens)", value: $model.contextWindowTokens, format: .number)
            Picker("Depth parameter", selection: $model.depthParameter) {
                Text("None").tag(String?.none)
                ForEach(CursorCatalogModel.depthParameters, id: \.self) { parameter in
                    Text(parameter).tag(String?.some(parameter))
                }
            }
            if model.depth != nil {
                CatalogValuesField(title: "Values", values: $model.depthValues)
                Picker("Default value", selection: $model.depthDefault) {
                    Text("None").tag(String?.none)
                    ForEach(model.depthValues, id: \.self) { value in
                        Text(value).tag(String?.some(value))
                    }
                }
            }
            Picker("Fast mode", selection: $model.fastByDefault) {
                Text("Not offered").tag(Bool?.none)
                Text("Off by default").tag(Bool?.some(false))
                Text("On by default").tag(Bool?.some(true))
            }
            if !model.isDefault {
                Button("Make Default Model", systemImage: "checkmark.circle", action: makeDefault)
                    .buttonStyle(.borderless)
            }
            ModelCatalogRowActions(store: store, runner: .cursor, rowID: model.rowID)
        } label: {
            ModelCatalogRowLabel(label: model.label, id: model.id, isDefault: model.isDefault)
        }
        .onAppear(perform: expandIfNew)
    }

    private func makeDefault() {
        store.makeCursorDefault(model.rowID)
    }

    private func expandIfNew() {
        if model.id.isEmpty {
            isExpanded = true
        }
    }
}
