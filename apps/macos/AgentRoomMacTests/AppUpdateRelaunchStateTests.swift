import XCTest
@testable import AgentRoomMac

final class AppUpdateRelaunchStateTests: XCTestCase {
    func testConsumesTheBackendRestartMarkerExactlyOnce() throws {
        let suiteName = "AppUpdateRelaunchStateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let state = AppUpdateRelaunchState(defaults: defaults)

        XCTAssertFalse(state.consumeBackendRestartRequired())

        state.markBackendRestartRequired()

        XCTAssertTrue(state.consumeBackendRestartRequired())
        XCTAssertFalse(state.consumeBackendRestartRequired())

        state.markBackendRestartRequired()
        state.clearBackendRestartRequired()
        XCTAssertFalse(state.consumeBackendRestartRequired())
    }

    @MainActor
    func testUpdateRelaunchRestartsOnlyABackendThatWasRunning() throws {
        let suiteName = "AppUpdateRelaunchStateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let state = AppUpdateRelaunchState(defaults: defaults)
        var backendWasRunning = false
        let controller = AppUpdateController(
            relaunchState: state,
            shouldRestartBackendAfterUpdate: { backendWasRunning },
            publicEDKey: ""
        )

        controller.recordBackendRestartIfNeeded()
        XCTAssertFalse(state.consumeBackendRestartRequired())

        backendWasRunning = true
        controller.recordBackendRestartIfNeeded()
        XCTAssertTrue(state.consumeBackendRestartRequired())
    }
}
