import SwiftUI

struct ThreadMessageContextStrip: View {
    var context: AgentSessionMessageContext

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let paths = context.paths, !paths.isEmpty {
                Label(paths.joined(separator: ", "), systemImage: "paperclip")
                    .lineLimit(2)
            }

            if let attachments = context.attachments, !attachments.isEmpty {
                Label(attachmentSummary(attachments), systemImage: "photo")
                    .lineLimit(2)
            }
        }
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }

    private func attachmentSummary(_ attachments: [AgentSessionMessageContextAttachment]) -> String {
        attachments.map { attachment in
            "\(attachment.sourceName) (\(attachment.sizeBytes.formatted()) bytes)"
        }
        .joined(separator: ", ")
    }
}
