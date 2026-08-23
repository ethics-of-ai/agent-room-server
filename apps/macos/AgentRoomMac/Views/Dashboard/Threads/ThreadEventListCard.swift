import SwiftUI

struct ThreadEventListCard: View {
    var events: [AgentRoomEvent]

    private var visibleEvents: [AgentRoomEvent] {
        Array(events.suffix(30).reversed())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(
                title: "Recent events",
                systemImage: "waveform.path.ecg",
                subtitle: "Filtered from the backend status snapshot"
            )

            if visibleEvents.isEmpty {
                ContentUnavailableView(
                    "No recent events",
                    systemImage: "clock.badge.questionmark",
                    description: Text("Recent status events for the selected session will appear here.")
                )
                .frame(minHeight: 180)
            } else {
                DividedVStack(items: visibleEvents) { event in
                    ThreadEventRow(event: event)
                }
            }
        }
        .cardBackground()
    }
}
