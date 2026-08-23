import SwiftUI

struct ThreadMessageListCard: View {
    var messages: [AgentSessionMessage]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Transcript",
                systemImage: "quote.bubble",
                subtitle: "Stored messages returned by the backend"
            )

            if messages.isEmpty {
                ContentUnavailableView(
                    "No messages",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("The selected session has no stored messages yet.")
                )
                .frame(minHeight: 220)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(messages) { message in
                                ThreadMessageRow(message: message)
                                    .id(message.id)
                            }
                        }
                    }
                    .frame(minHeight: 240, maxHeight: 480)
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: messages.last?.id) {
                        scrollToLatest(using: proxy)
                    }
                }
            }
        }
        .cardBackground()
    }

    private func scrollToLatest(using proxy: ScrollViewProxy) {
        guard let lastID = messages.last?.id else { return }
        if reduceMotion {
            proxy.scrollTo(lastID, anchor: .bottom)
        } else {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(lastID, anchor: .bottom)
            }
        }
    }
}
