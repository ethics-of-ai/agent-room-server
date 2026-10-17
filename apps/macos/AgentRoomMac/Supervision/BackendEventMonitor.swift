import Foundation

/// Listens on the backend's event socket for the two invalidations the Mac operator
/// surface acts on.
/// `config_reloaded` means another client patched the backend-owned settings
/// file; the socket carries no setting values, and the supervisor follows it with
/// the authoritative `GET /api/config` plus a local file read.
/// `workspace_branch_changed` means a registered checkout moved to another
/// branch, from any source, so the supervisor re-reads `/api/workspaces` and
/// every thread row shows the branch the Mac is on.
@MainActor
final class BackendEventMonitor {
    /// What a frame means to this monitor; every other event is `.other`.
    enum EventKind: Sendable {
        case configReloaded
        case workspaceBranchChanged
        case other
    }

    /// What the supervisor runs for each kind of event.
    struct Handlers {
        var onConfigReloaded: @MainActor () async -> Void
        var onWorkspaceBranchChanged: @MainActor () async -> Void
    }

    private var connectionURL: URL?
    private var authToken = ""
    private var socket: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var handlers: Handlers?
    /// A burst of branch events runs one refresh and queues at most one more.
    private lazy var branchRefresh = CoalescingRefresh { [weak self] in
        await self?.handlers?.onWorkspaceBranchChanged()
    }

    func connect(baseURL: URL, authToken: String, handlers: Handlers) {
        self.handlers = handlers
        guard let eventURL = Self.eventURL(from: baseURL) else { return }
        guard connectionURL != eventURL
            || self.authToken != authToken
            || (socket == nil && reconnectTask == nil) else {
            return
        }

        disconnect()
        connectionURL = eventURL
        self.authToken = authToken
        let generation = UUID()
        connectionGeneration = generation
        open(url: eventURL, authToken: authToken, generation: generation)
    }

    func disconnect() {
        connectionGeneration = UUID()
        reconnectTask?.cancel()
        reconnectTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectionURL = nil
        authToken = ""
    }

    private func open(url: URL, authToken: String, generation: UUID) {
        reconnectTask = nil
        var request = URLRequest(url: url)
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        receive(generation: generation)
    }

    private func receive(generation: UUID) {
        socket?.receive { [weak self] result in
            // Frames can contain large coding deltas. Classify on URLSession's
            // delivery queue and move only an EventKind? onto the main actor;
            // nil is a disconnect.
            let outcome = Self.classify(result)
            Task { @MainActor in
                self?.handle(outcome, generation: generation)
            }
        }
    }

    private nonisolated static func classify(
        _ result: Result<URLSessionWebSocketTask.Message, Error>
    ) -> EventKind? {
        switch result {
        case .success(let message):
            return kind(of: message)
        case .failure:
            return nil
        }
    }

    private func handle(_ outcome: EventKind?, generation: UUID) {
        guard generation == connectionGeneration else { return }
        guard let outcome else {
            socket = nil
            scheduleReconnect(generation: generation)
            return
        }

        receive(generation: generation)
        switch outcome {
        case .configReloaded:
            guard let onConfigReloaded = handlers?.onConfigReloaded else { return }
            Task { await onConfigReloaded() }
        case .workspaceBranchChanged:
            branchRefresh.request()
        case .other:
            break
        }
    }

    private func scheduleReconnect(generation: UUID) {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            guard let self,
                  generation == connectionGeneration,
                  let connectionURL else {
                return
            }
            open(url: connectionURL, authToken: authToken, generation: generation)
        }
    }

    nonisolated static func kind(of message: URLSessionWebSocketTask.Message) -> EventKind {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let bytes):
            data = bytes
        @unknown default:
            return .other
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .other
        }
        switch object["type"] as? String {
        case "config_reloaded": return .configReloaded
        case "workspace_branch_changed": return .workspaceBranchChanged
        default: return .other
        }
    }

    private static func eventURL(from baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/events"
        components.queryItems = [URLQueryItem(name: "legacyTurnEvents", value: "false")]
        return components.url
    }
}
