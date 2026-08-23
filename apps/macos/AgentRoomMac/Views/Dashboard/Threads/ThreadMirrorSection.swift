import SwiftUI

struct ThreadMirrorSection: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @Environment(BackendThreadMirrorStore.self) private var threadMirrorStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var threadMirrorStore = threadMirrorStore
        VStack(alignment: .leading, spacing: DashboardTheme.cardSpacing) {
            ThreadMirrorSummaryCard(
                sessionCount: threadMirrorStore.sessions.count,
                runningCount: threadMirrorStore.runningCount,
                idleCount: threadMirrorStore.idleCount,
                failedCount: threadMirrorStore.failedCount,
                totalTokens: threadMirrorStore.totalTokens,
                isRefreshing: threadMirrorStore.isRefreshing,
                lastRefreshedAt: threadMirrorStore.lastRefreshedAt,
                lastError: threadMirrorStore.lastError,
                refreshAction: refreshThreads
            )

            HStack(alignment: .top, spacing: DashboardTheme.cardSpacing) {
                ThreadSessionListCard(
                    sessions: threadMirrorStore.sessions,
                    selectedSessionID: $threadMirrorStore.selectedSessionID
                )
                .frame(minWidth: 300, idealWidth: 340, maxWidth: 380)

                if let session = threadMirrorStore.selectedSession {
                    VStack(alignment: .leading, spacing: DashboardTheme.cardSpacing) {
                        ThreadMetadataCard(
                            session: session,
                            isCancelling: threadMirrorStore.isCancelling(session),
                            stopAction: stopSelectedTurn
                        )
                        ThreadMessageListCard(messages: threadMirrorStore.selectedMessages)
                        ThreadEventListCard(events: threadMirrorStore.selectedEvents)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    ThreadMirrorEmptyDetailCard()
                }
            }
        }
        // Keyed on scenePhase so the 3 s poll loop cancels while the window is
        // inactive/backgrounded (it used to poll a minimized dashboard forever)
        // and restarts when it becomes active again.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await threadMirrorStore.runPolling {
                supervisor.currentAPIClient()
            }
        }
        .onChange(of: threadMirrorStore.selectedSessionID) {
            refreshSelectedMessages()
        }
    }

    private func refreshThreads() {
        Task {
            await threadMirrorStore.refresh(using: supervisor.currentAPIClient())
        }
    }

    private func refreshSelectedMessages() {
        Task {
            await threadMirrorStore.refreshSelectedMessages(using: supervisor.currentAPIClient())
        }
    }

    private func stopSelectedTurn() {
        Task {
            await threadMirrorStore.cancelSelectedSession(using: supervisor.currentAPIClient())
        }
    }
}
