import Foundation

/// Remembers which process this app launched as the backend sidecar, so the
/// next launch can tell its own orphan from a backend the operator started
/// themselves.
///
/// It lives in the app's own defaults rather than under `AGENTROOM_HOME`,
/// because it describes this app's supervision rather than the backend's state:
/// the backend never reads it, and a second AgentRoom install supervising the
/// same directory would be describing a different process.
struct BackendSidecarRecordStore {
    private let defaults: UserDefaults
    private let key = "backendSidecarProcess"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> BackendProcessIdentity? {
        guard let data = defaults.data(forKey: key) else {
            return nil
        }
        return try? JSONDecoder().decode(BackendProcessIdentity.self, from: data)
    }

    func save(_ identity: BackendProcessIdentity) {
        guard let data = try? JSONEncoder().encode(identity) else {
            return
        }
        defaults.set(data, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}
