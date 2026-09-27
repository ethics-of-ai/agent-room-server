import SwiftUI

/// A collapsed model row: its name, then its id.
struct ModelCatalogRowLabel: View {
    var label: String
    var id: String
    var isDefault = false

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text(label.isEmpty ? "New model" : label)
                if isDefault {
                    Text("Default")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text(id.isEmpty ? "No ID yet" : id)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
    }
}
