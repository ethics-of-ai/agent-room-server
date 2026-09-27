import SwiftUI

/// A comma-separated list field. The text is kept locally so typing a comma or
/// space is not rewritten mid-edit; the values update on every change.
struct CatalogValuesField: View {
    var title: String
    @Binding var values: [String]
    @State private var text = ""

    var body: some View {
        TextField(title, text: $text, prompt: Text("low, medium, high"))
            .onAppear(perform: showValues)
            .onChange(of: text) { _, newText in
                values = newText
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            }
    }

    private func showValues() {
        text = values.joined(separator: ", ")
    }
}
