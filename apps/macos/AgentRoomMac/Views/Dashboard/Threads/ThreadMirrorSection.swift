import SwiftUI

struct ThreadMirrorSection: View {
    @Environment(BackendSupervisor.self) private var supervisor
    @Environment(BackendThreadMirrorStore.self) private var threadMirrorStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var query = ""
    @State private var filter: ThreadStatusFilter = .all

    private var visibleSessions: [AgentSession] {
        filter.sessions(in: threadMirrorStore.sessions, query: query)
    }

    private var selectionIsHidden: Bool {
        guard let id = threadMirrorStore.selectedSession?.id else { return false }
        return !visibleSessions.contains { $0.id == id }
    }

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
            HSplitView {
                ThreadSessionListCard(
                    sessions: visibleSessions,
                    hasSessions: !threadMirrorStore.sessions.isEmpty,
                    selectedSessionID: $threadMirrorStore.selectedSessionID,
                    query: $query, filter: $filter
                )
                .frame(minWidth: 240, idealWidth: 300, maxWidth: 320)
                ZStack {
                    if let session = threadMirrorStore.selectedSession {
                        ThreadSelectedDetail(
                            session: session,
                            messages: threadMirrorStore.selectedMessages,
                            events: threadMirrorStore.selectedEvents,
                            isCancelling: threadMirrorStore.isCancelling(session),
                            stopAction: stopSelectedTurn
                        )
                        .id(session.id)
                        .opacity(selectionIsHidden ? 0 : 1)
                        .allowsHitTesting(!selectionIsHidden)
                        .disabled(selectionIsHidden)
                        .accessibilityHidden(selectionIsHidden)
                    }
                    if threadMirrorStore.selectedSession == nil || selectionIsHidden {
                        ThreadSelectionPlaceholder(
                            isHidden: selectionIsHidden,
                            isUnavailable: threadMirrorStore.selectedSessionID != nil,
                            clearFilters: clearFilters
                        )
                    }
                }
                .padding(.leading, DashboardTheme.rowSpacing)
                .frame(minWidth: 280, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await threadMirrorStore.runPolling { supervisor.currentAPIClient() }
        }
        .onChange(of: threadMirrorStore.selectedSessionID) { refreshSelectedMessages() }
    }

    private func clearFilters() { query = ""; filter = .all }
    private func refreshThreads() {
        Task { await threadMirrorStore.refresh(using: supervisor.currentAPIClient()) }
    }
    private func refreshSelectedMessages() {
        Task { await threadMirrorStore.refreshSelectedMessages(using: supervisor.currentAPIClient()) }
    }
    private func stopSelectedTurn() {
        guard !selectionIsHidden else { return }
        Task { await threadMirrorStore.cancelSelectedSession(using: supervisor.currentAPIClient()) }
    }
}
