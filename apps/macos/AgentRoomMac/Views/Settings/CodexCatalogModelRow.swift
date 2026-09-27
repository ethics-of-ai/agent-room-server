import SwiftUI

struct CodexCatalogModelRow: View {
    @Binding var model: CodexCatalogModel
    var store: ModelCatalogEditorStore
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            TextField("ID", text: $model.id, prompt: Text("gpt-6-sol"))
            TextField("Name", text: $model.label)
            TextField("Description", text: $model.description, axis: .vertical)
            CatalogValuesField(title: "Effort levels", values: $model.efforts)
            Picker("Default effort", selection: $model.defaultReasoningEffort) {
                Text("None").tag(String?.none)
                ForEach(model.efforts, id: \.self) { effort in
                    Text(effort).tag(String?.some(effort))
                }
            }
            Toggle("Offers fast mode", isOn: $model.fast)
            if !model.isDefault {
                Button("Make Default Model", systemImage: "checkmark.circle", action: makeDefault)
                    .buttonStyle(.borderless)
            }
            ModelCatalogRowActions(store: store, runner: .codex, rowID: model.rowID)
        } label: {
            ModelCatalogRowLabel(label: model.label, id: model.id, isDefault: model.isDefault)
        }
        .onAppear(perform: expandIfNew)
    }

    private func makeDefault() {
        store.makeCodexDefault(model.rowID)
    }

    private func expandIfNew() {
        if model.id.isEmpty {
            isExpanded = true
        }
    }
}
