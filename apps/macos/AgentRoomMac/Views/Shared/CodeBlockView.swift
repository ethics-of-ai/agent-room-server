import SwiftUI

struct CodeBlockView: View {
    var text: String
    var minHeight: CGFloat = 96

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .frame(minHeight: minHeight, maxHeight: 220)
        .innerSurface()
    }
}
