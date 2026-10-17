import Foundation
import XCTest
@testable import AgentRoomMac

final class BackendEventMonitorTests: XCTestCase {
    func testRecognizesOnlyTopLevelConfigReloadedEvents() {
        let reloaded = URLSessionWebSocketTask.Message.string(
            #"{"id":"event-1","type":"config_reloaded","at":"now","payload":{}}"#
        )
        let unrelated = URLSessionWebSocketTask.Message.string(
            #"{"id":"event-2","type":"coding_assistant_message_delta","at":"now","payload":{"delta":"config_reloaded"}}"#
        )

        XCTAssertEqual(BackendEventMonitor.kind(of: reloaded), .configReloaded)
        XCTAssertEqual(BackendEventMonitor.kind(of: unrelated), .other)
    }

    func testRecognizesWorkspaceBranchChangesFromEveryOrigin() {
        let observed = URLSessionWebSocketTask.Message.string(
            #"{"id":"e","type":"workspace_branch_changed","at":"now","payload":{"workspaceId":"w","branch":"main","origin":"observed"}}"#
        )
        let announced = URLSessionWebSocketTask.Message.data(Data(
            #"{"id":"e","type":"workspace_branch_changed","at":"now","payload":{"workspaceId":"w","branch":"main"}}"#.utf8
        ))
        let gitOperation = URLSessionWebSocketTask.Message.string(
            #"{"id":"e","type":"workspace_git_operation","at":"now","payload":{"branch":"workspace_branch_changed"}}"#
        )

        XCTAssertEqual(BackendEventMonitor.kind(of: observed), .workspaceBranchChanged)
        XCTAssertEqual(BackendEventMonitor.kind(of: announced), .workspaceBranchChanged)
        XCTAssertEqual(BackendEventMonitor.kind(of: gitOperation), .other)
        XCTAssertEqual(BackendEventMonitor.kind(of: .string("not json")), .other)
    }
}
