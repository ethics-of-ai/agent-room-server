import XCTest
@testable import AgentRoomMac

@MainActor
final class BackendProcessTerminatorTests: XCTestCase {
    func testReturnsAfterTheBackendHandlesInterrupt() async {
        let process = FakeBackendProcess()
        process.onInterrupt = { process.isRunning = false }

        let stopped = await BackendProcessTerminator(
            gracefulTimeout: .seconds(1),
            terminationTimeout: .zero,
            pollInterval: .milliseconds(1)
        ).stopAndWait(process)

        XCTAssertTrue(stopped)
        XCTAssertEqual(process.signals, [.interrupt])
    }

    func testEscalatesAndWaitsForTermination() async {
        let process = FakeBackendProcess()
        process.onTerminate = { process.isRunning = false }

        let stopped = await BackendProcessTerminator(
            gracefulTimeout: .zero,
            terminationTimeout: .seconds(1),
            pollInterval: .milliseconds(1)
        ).stopAndWait(process)

        XCTAssertTrue(stopped)
        XCTAssertEqual(process.signals, [.interrupt, .terminate])
    }

    func testRefusesApplicationTerminationWhenTheBackendRemainsAlive() async {
        let process = FakeBackendProcess()

        let stopped = await BackendProcessTerminator(
            gracefulTimeout: .zero,
            terminationTimeout: .zero,
            pollInterval: .milliseconds(1)
        ).stopAndWait(process)

        XCTAssertFalse(stopped)
        XCTAssertEqual(process.signals, [.interrupt, .terminate])
    }
}

private final class FakeBackendProcess: BackendProcessControlling {
    enum Signal {
        case interrupt
        case terminate
    }

    var isRunning = true
    var onInterrupt: (() -> Void)?
    var onTerminate: (() -> Void)?
    private(set) var signals: [Signal] = []

    func interrupt() {
        signals.append(.interrupt)
        onInterrupt?()
    }

    func terminate() {
        signals.append(.terminate)
        onTerminate?()
    }
}
