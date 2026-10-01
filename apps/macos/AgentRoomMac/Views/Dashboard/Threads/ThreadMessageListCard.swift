import SwiftUI

struct ThreadMessageListCard: View {
    var messages: [AgentSessionMessage]

    var body: some View {
        if messages.isEmpty {
            ContentUnavailableView("No messages", systemImage: "bubble.left.and.text.bubble.right",
                                   description: Text("This session has no stored messages yet."))
        } else {
            ThreadReadingScrollView(items: messages) { message in
                ThreadMessageRow(message: message)
            }
        }
    }
}
