import XCTest
@testable import AgentRoomMac

final class ThreadMessageOriginTests: XCTestCase {
    func testChildThreadOriginsLabelTheirSystemRows() {
        XCTAssertEqual(message(role: "system", origin: "parent_task").threadRoleLabel, "Task from parent thread")
        XCTAssertEqual(message(role: "system", origin: "parent_message").threadRoleLabel, "Message from parent thread")
        XCTAssertEqual(message(role: "system", origin: "child_report").threadRoleLabel, "Child report")
        XCTAssertEqual(message(role: "system", origin: "child_report").threadRoleSystemImage, "tray.full")
        XCTAssertEqual(message(role: "system", origin: "parent_task").threadRoleSystemImage, "arrow.triangle.branch")
    }

    func testOtherMessagesKeepTheirRoleLabel() {
        XCTAssertEqual(message(role: "system", origin: nil).threadRoleLabel, "System")
        XCTAssertEqual(message(role: "system", origin: "something_newer").threadRoleLabel, "System")
        XCTAssertEqual(message(role: "system", origin: nil).threadRoleSystemImage, "gearshape")
        XCTAssertEqual(message(role: "user", origin: "parent_task").threadRoleLabel, "User")
    }

    private func message(role: String, origin: String?) -> AgentSessionMessage {
        AgentSessionMessage(
            id: "m1", sessionId: "s1", turnId: "t1", role: role, content: "Text",
            context: nil, origin: origin, status: "completed", at: "2026-11-01T00:00:00Z"
        )
    }
}
