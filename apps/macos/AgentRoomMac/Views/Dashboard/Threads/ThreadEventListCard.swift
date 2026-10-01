import SwiftUI

struct ThreadEventListCard: View {
    var events: [AgentRoomEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.elementSpacing) {
            Text("Bounded recent activity from the backend status snapshot")
                .font(.caption).foregroundStyle(.secondary)
            if events.isEmpty {
                ContentUnavailableView("No recent events", systemImage: "clock.badge.questionmark")
            } else {
                ThreadReadingScrollView(items: Array(events.suffix(30))) { event in
                    ThreadEventRow(event: event)
                }
            }
        }
    }
}
