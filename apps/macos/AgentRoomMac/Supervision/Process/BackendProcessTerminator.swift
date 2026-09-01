import Foundation

/// Stops an app-owned backend under a bounded deadline before AppKit allows
/// the application to terminate. Returning `false` keeps the old app in place.
@MainActor
struct BackendProcessTerminator {
    let gracefulTimeout: Duration
    let terminationTimeout: Duration
    let pollInterval: Duration

    init(
        gracefulTimeout: Duration = .seconds(3),
        terminationTimeout: Duration = .seconds(2),
        pollInterval: Duration = .milliseconds(50)
    ) {
        self.gracefulTimeout = gracefulTimeout
        self.terminationTimeout = terminationTimeout
        self.pollInterval = pollInterval
    }

    func stopAndWait(_ process: any BackendProcessControlling) async -> Bool {
        process.interrupt()
        if await waitForExit(of: process, timeout: gracefulTimeout) {
            return true
        }

        process.terminate()
        return await waitForExit(of: process, timeout: terminationTimeout)
    }

    private func waitForExit(
        of process: any BackendProcessControlling,
        timeout: Duration
    ) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while process.isRunning {
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: pollInterval)
        }
        return true
    }
}
