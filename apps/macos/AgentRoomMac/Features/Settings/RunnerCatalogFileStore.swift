import Foundation

/// Reads `$AGENTROOM_HOME/config/runners.json` — the runner catalog a backend
/// that started successfully leaves beside its settings file.
///
/// This is the offline half of `docs/engineering/RUNNERS.md`. The settings panes edit
/// `settings.json` **while the backend is stopped**, which is exactly when an
/// operator is fixing why it would not start — and `runnerKind` is a picker over
/// runners only the backend knows. So the app carries a build-time floor
/// (`RunnerCatalog.builtIn`) and *prefers* this override when it is one this
/// release understands, which is what lets a runner registered after the app
/// shipped still appear in that picker.
///
/// The override is a cache, never a source of truth. A live `GET /api/runners`
/// always wins while the backend is running; an unreadable, empty, or
/// newer-versioned file falls back to the bundle rather than to nothing; and
/// nothing here is ever written — the backend owns this file.
struct RunnerCatalogFileStore {
    /// The document shape this app understands. A newer one falls back to the
    /// bundled floor rather than being guessed at.
    static let supportedSchemaVersion = 1

    /// Mirrors `resolveRunnerCatalogPath` in the backend's runner catalog file.
    static func fileURL(forAgentRoomHomePath agentRoomHomePath: String) -> URL {
        URL(fileURLWithPath: agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("runners.json")
    }

    private struct Document: Decodable {
        var schemaVersion: Int
        var runners: [RunnerDescriptor]
    }

    /// The catalog the file describes, or `nil` for every reason a caller should
    /// fall back to the bundled floor: absent, unreadable, malformed, newer than
    /// this release, or empty.
    func read(at url: URL) -> RunnerCatalog? {
        guard let data = try? Data(contentsOf: url),
              let document = try? JSONDecoder().decode(Document.self, from: data),
              document.schemaVersion == Self.supportedSchemaVersion,
              !document.runners.isEmpty else {
            return nil
        }
        return RunnerCatalog(descriptors: document.runners)
    }
}
