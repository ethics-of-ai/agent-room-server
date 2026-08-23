import Foundation
import Observation

@MainActor
@Observable
final class BackendThreadMirrorStore {
    private(set) var status: StatusSnapshot?
    private(set) var sessions: [AgentSession] = []
    private(set) var messagesBySessionID: [String: [AgentSessionMessage]] = [:]
    private(set) var isRefreshing = false
    private(set) var lastError: String?
    private(set) var lastRefreshedAt: Date?
    private(set) var cancellingSessionIDs: Set<String> = []
    var selectedSessionID: String?
    /// `updatedAt:status` of a session at its last transcript fetch, used to
    /// skip refetching an unchanged idle session's messages on every poll tick.
    private var messagesSyncKeyBySessionID: [String: String] = [:]

    var selectedSession: AgentSession? {
        guard let selectedSessionID else {
            return nil
        }
        return sessions.first { $0.id == selectedSessionID }
    }

    var selectedMessages: [AgentSessionMessage] {
        guard let selectedSessionID else {
            return []
        }
        return messagesBySessionID[selectedSessionID] ?? []
    }

    var selectedEvents: [AgentRoomEvent] {
        guard let selectedSessionID else {
            return []
        }
        return status?.recentEvents.filter { $0.sessionId == selectedSessionID } ?? []
    }

    var runningCount: Int {
        sessions.filter(\.threadIsRunning).count
    }

    var failedCount: Int {
        sessions.filter { $0.status.lowercased() == "failed" }.count
    }

    var idleCount: Int {
        sessions.filter { $0.status.lowercased() == "idle" }.count
    }

    var totalTokens: Int {
        // No session-level fallback: `contextWindowUsedTokens` is live context
        // occupancy (latest request footprint), not a cumulative total.
        status?.metrics.totalTokens ?? 0
    }

    func runPolling(using makeClient: @MainActor @escaping () -> APIClient) async {
        await refresh(using: makeClient())
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                break
            }
            await refresh(using: makeClient())
        }
    }

    func refresh(using client: APIClient) async {
        guard !isRefreshing else {
            return
        }

        isRefreshing = true
        defer { isRefreshing = false }

        do {
            async let statusTask: StatusSnapshot = client.fetchStatus()
            async let sessionsTask: AgentSessionListResponse = client.fetchAgentSessions()
            let (loadedStatus, sessionResponse) = try await (statusTask, sessionsTask)
            // Assign only on change: an unconditional assignment fires
            // observation on every 3 s tick even when the backend is idle,
            // re-rendering every card that reads these.
            if status != loadedStatus {
                status = loadedStatus
            }
            let sortedSessions = Self.sortedSessions(sessionResponse.sessions)
            if sessions != sortedSessions {
                sessions = sortedSessions
            }
            reconcileSelection()
            lastRefreshedAt = Date.now
            if lastError != nil {
                lastError = nil
            }

            if let selectedSessionID {
                await refreshMessagesIfStale(for: selectedSessionID, using: client)
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshSelectedMessages(using client: APIClient) async {
        guard let selectedSessionID else {
            return
        }
        await refreshMessages(for: selectedSessionID, using: client)
    }

    func cancelSelectedSession(using client: APIClient) async {
        guard let session = selectedSession, session.threadIsRunning else {
            return
        }

        cancellingSessionIDs.insert(session.id)
        defer { cancellingSessionIDs.remove(session.id) }

        do {
            let updatedSession = try await client.cancelAgentSession(sessionId: session.id)
            upsert(updatedSession)
            lastError = nil
            await refresh(using: client)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func isCancelling(_ session: AgentSession) -> Bool {
        cancellingSessionIDs.contains(session.id)
    }

    /// Poll-path transcript refresh. An idle session's transcript cannot have
    /// changed since the last poll, so the full message fetch + decode is
    /// skipped unless the session is running, its `updatedAt` moved, or its
    /// messages were never loaded.
    private func refreshMessagesIfStale(for sessionID: String, using client: APIClient) async {
        let session = sessions.first { $0.id == sessionID }
        let syncKey = "\(session?.updatedAt ?? ""):\(session?.status ?? "")"
        let isRunning = session?.threadIsRunning ?? false
        guard isRunning
            || messagesBySessionID[sessionID] == nil
            || messagesSyncKeyBySessionID[sessionID] != syncKey else {
            return
        }
        await refreshMessages(for: sessionID, using: client)
        messagesSyncKeyBySessionID[sessionID] = syncKey
    }

    private func refreshMessages(for sessionID: String, using client: APIClient) async {
        do {
            let response = try await client.fetchAgentSessionMessages(sessionId: sessionID)
            if messagesBySessionID[sessionID] != response.messages {
                messagesBySessionID[sessionID] = response.messages
            }
            if lastError != nil {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func reconcileSelection() {
        if let selectedSessionID, sessions.contains(where: { $0.id == selectedSessionID }) {
            return
        }
        selectedSessionID = sessions.first?.id
    }

    private func upsert(_ session: AgentSession) {
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session
        } else {
            sessions.append(session)
        }
        sessions = Self.sortedSessions(sessions)
    }

    private static func sortedSessions(_ sessions: [AgentSession]) -> [AgentSession] {
        sessions.sorted { lhs, rhs in
            lhs.updatedAt > rhs.updatedAt
        }
    }
}
