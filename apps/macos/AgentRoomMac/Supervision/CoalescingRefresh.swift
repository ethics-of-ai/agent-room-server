import Foundation

/// Runs an async refresh so that a burst of requests costs at most two runs: the one
/// already running, and one more queued behind it that sees every change the burst made.
@MainActor
final class CoalescingRefresh {
    private let work: @MainActor () async -> Void
    private var running: Task<Void, Never>?
    private var pending = false

    init(_ work: @escaping @MainActor () async -> Void) {
        self.work = work
    }

    func request() {
        guard running == nil else {
            pending = true
            return
        }
        running = Task { [weak self] in
            await self?.drain()
        }
    }

    /// Waits for the running refresh and any queued behind it. For tests.
    func settle() async {
        await running?.value
    }

    private func drain() async {
        repeat {
            pending = false
            await work()
        } while pending
        running = nil
    }
}
