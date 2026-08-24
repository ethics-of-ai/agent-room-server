import Darwin
import Foundation

/// A backend sidecar this app started in an earlier launch and has recognised
/// again. It deliberately supplies only the lifecycle surface supervision
/// shares with an owned `Process`: its stdout and stderr belonged to the app
/// session that spawned it, so an adopted process starts with empty local logs.
struct AdoptedBackendProcess: BackendProcessControlling {
    let identity: BackendProcessIdentity
    private let inspector: any BackendProcessInspecting

    init(identity: BackendProcessIdentity, inspector: any BackendProcessInspecting) {
        self.identity = identity
        self.inspector = inspector
    }

    var isRunning: Bool {
        inspector.isAlive(identity)
    }

    func interrupt() {
        inspector.signal(SIGINT, to: identity)
    }

    func terminate() {
        inspector.signal(SIGTERM, to: identity)
    }
}
