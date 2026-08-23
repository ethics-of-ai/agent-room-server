import SwiftUI

/// A leading-aligned vertical stack that draws a faint divider between rows.
struct DividedVStack<Item: Identifiable, Row: View>: View {
    var items: [Item]
    @ViewBuilder var row: (Item) -> Row

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items) { item in
                if item.id != items.first?.id {
                    Divider().opacity(0.5)
                }
                row(item)
            }
        }
    }
}
