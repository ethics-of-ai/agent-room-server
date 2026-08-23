import Foundation

/// Keeps the Mac operator surface synchronized when another client patches the
/// backend-owned settings file. The socket carries no setting values;
/// `config_reloaded` is only an invalidation signal, and the supervisor follows
/// it with the authoritative `GET /api/config` plus a local file read.
@MainActor
final class BackendSettingsEventMonitor {
    private var connectionURL: URL?
    private var authToken = ""
    private var socket: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var connectionGeneration = UUID()

    func connect(
        baseURL: URL,
        authToken: String,
        onConfigReloaded: @escaping @MainActor () async -> Void
    ) {
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
        open(url: eventURL, authToken: authToken, generation: generation, onConfigReloaded: onConfigReloaded)
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

    private func open(
        url: URL,
        authToken: String,
        generation: UUID,
        onConfigReloaded: @escaping @MainActor () async -> Void
    ) {
        reconnectTask = nil
        var request = URLRequest(url: url)
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        receive(generation: generation, onConfigReloaded: onConfigReloaded)
    }

    private func receive(
        generation: UUID,
        onConfigReloaded: @escaping @MainActor () async -> Void
    ) {
        socket?.receive { [weak self] result in
            // Frames can contain large coding deltas. Classify on URLSession's
            // delivery queue and move only a Bool? onto the main actor: true is
            // config_reloaded, false is another healthy event, nil is disconnect.
            let outcome = Self.classify(result)
            Task { @MainActor in
                self?.handle(
                    outcome,
                    generation: generation,
                    onConfigReloaded: onConfigReloaded
                )
            }
        }
    }

    private nonisolated static func classify(
        _ result: Result<URLSessionWebSocketTask.Message, Error>
    ) -> Bool? {
        switch result {
        case .success(let message):
            return isConfigReloaded(message)
        case .failure:
            return nil
        }
    }

    private func handle(
        _ outcome: Bool?,
        generation: UUID,
        onConfigReloaded: @escaping @MainActor () async -> Void
    ) {
        guard generation == connectionGeneration else { return }
        guard let outcome else {
            socket = nil
            scheduleReconnect(generation: generation, onConfigReloaded: onConfigReloaded)
            return
        }

        receive(generation: generation, onConfigReloaded: onConfigReloaded)
        if outcome {
            Task { await onConfigReloaded() }
        }
    }

    private func scheduleReconnect(
        generation: UUID,
        onConfigReloaded: @escaping @MainActor () async -> Void
    ) {
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
            open(
                url: connectionURL,
                authToken: authToken,
                generation: generation,
                onConfigReloaded: onConfigReloaded
            )
        }
    }

    nonisolated static func isConfigReloaded(_ message: URLSessionWebSocketTask.Message) -> Bool {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let bytes):
            data = bytes
        @unknown default:
            return false
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object["type"] as? String == "config_reloaded"
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
