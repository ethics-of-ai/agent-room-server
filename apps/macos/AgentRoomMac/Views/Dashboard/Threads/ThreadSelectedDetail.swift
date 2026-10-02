import SwiftUI

struct ThreadSelectedDetail: View {
    var session: AgentSession
    var messages: [AgentSessionMessage]
    var events: [AgentRoomEvent]
    var isCancelling: Bool
    var stopAction: () -> Void
    @State private var tab: ThreadContentTab = .transcript

    var body: some View {
        VStack(alignment: .leading, spacing: DashboardTheme.rowSpacing) {
            ThreadMetadataCard(session: session, isCancelling: isCancelling, stopAction: stopAction)
            Picker("Thread content", selection: $tab) {
                ForEach(ThreadContentTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .modifier(ThreadContentPickerStyle())
            ZStack {
                ThreadMessageListCard(messages: messages)
                    .opacity(tab == .transcript ? 1 : 0)
                    .allowsHitTesting(tab == .transcript)
                    .disabled(tab != .transcript)
                    .accessibilityHidden(tab != .transcript)
                ThreadEventListCard(events: events)
                    .opacity(tab == .events ? 1 : 0)
                    .allowsHitTesting(tab == .events)
                    .disabled(tab != .events)
                    .accessibilityHidden(tab != .events)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
