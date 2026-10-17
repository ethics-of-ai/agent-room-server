import XCTest
@testable import AgentRoomMac

@MainActor
final class CoalescingRefreshTests: XCTestCase {
    /// Counts runs and can hold the first one open, so a test can send a burst while it runs.
    private final class Probe {
        var runs = 0
        var holdFirstRun = false
        var heldRun: CheckedContinuation<Void, Never>?
    }

    func testABurstDuringARunQueuesExactlyOneMore() async throws {
        let probe = Probe()
        probe.holdFirstRun = true
        let refresh = CoalescingRefresh {
            probe.runs += 1
            if probe.runs == 1, probe.holdFirstRun {
                await withCheckedContinuation { probe.heldRun = $0 }
            }
        }

        refresh.request()
        try await waitUntil { probe.heldRun != nil }
        for _ in 0..<5 { refresh.request() }
        probe.heldRun?.resume()
        await refresh.settle()

        XCTAssertEqual(probe.runs, 2)
    }

    func testARequestAfterARunFinishesStartsANewRun() async {
        let probe = Probe()
        let refresh = CoalescingRefresh { probe.runs += 1 }

        refresh.request()
        await refresh.settle()
        refresh.request()
        await refresh.settle()

        XCTAssertEqual(probe.runs, 2)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for the refresh to start")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
