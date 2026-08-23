import Foundation
import XCTest
@testable import AgentRoomMac

final class BackendSettingsEventMonitorTests: XCTestCase {
    func testRecognizesOnlyTopLevelConfigReloadedEvents() {
        let reloaded = URLSessionWebSocketTask.Message.string(
            #"{"id":"event-1","type":"config_reloaded","at":"now","payload":{}}"#
        )
        let unrelated = URLSessionWebSocketTask.Message.string(
            #"{"id":"event-2","type":"coding_assistant_message_delta","at":"now","payload":{"delta":"config_reloaded"}}"#
        )

        XCTAssertTrue(BackendSettingsEventMonitor.isConfigReloaded(reloaded))
        XCTAssertFalse(BackendSettingsEventMonitor.isConfigReloaded(unrelated))
    }
}
