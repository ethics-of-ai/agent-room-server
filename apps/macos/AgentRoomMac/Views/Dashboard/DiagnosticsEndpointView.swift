import SwiftUI

struct DiagnosticsEndpointView: View {
    var title: String
    var systemImage: String
    var path: String
    var value: String?
    var openEndpoint: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(title, systemImage: systemImage)
                    .font(.callout.weight(.semibold))
                Spacer()
                EndpointTag(path: path)
                if let openEndpoint {
                    Button("Open \(path)", systemImage: "arrow.up.right.square") {
                        openEndpoint(path)
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help("Open \(path) in the browser")
                }
            }
            CodeBlockView(text: value ?? "Refresh diagnostics to load \(path).")
        }
    }
}
