import SwiftUI

struct ThreadSessionListCard: View {
    var sessions: [AgentSession]
    @Binding var selectedSessionID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Sessions",
                systemImage: "list.bullet.rectangle",
                subtitle: "Backend threads visible to all clients"
            )

            if sessions.isEmpty {
                ContentUnavailableView(
                    "No threads",
                    systemImage: "text.bubble",
                    description: Text("Create a session from a client and it will appear here.")
                )
                .frame(minHeight: 420)
            } else {
                List(selection: $selectedSessionID) {
                    ForEach(sessions) { session in
                        ThreadSessionRow(session: session)
                            .tag(session.id)
                    }
                }
                .listStyle(.inset)
                .frame(minHeight: 420, idealHeight: 520)
            }
        }
        .cardBackground()
    }
}
