import XCTest
@testable import AgentRoomMac

final class ManagedSettingStatusTests: XCTestCase {
    func testEnvironmentLockDisplaysTheRunningValue() {
        let runner = ManagedSettingStatus(
            metadata: PublicManagedSetting(
                value: .string("claude_code"),
                source: "env",
                tier: 1,
                editable: false
            )
        )
        let terminal = ManagedSettingStatus(
            metadata: PublicManagedSetting(
                value: .bool(true),
                source: "env",
                tier: 2,
                editable: false
            )
        )

        XCTAssertEqual(runner.displayedString(fileValue: "codex"), "claude_code")
        XCTAssertTrue(terminal.displayedBool(fileValue: false))
    }

    func testUnlockedSettingDisplaysTheFileValuePendingRestart() {
        let status = ManagedSettingStatus(
            metadata: PublicManagedSetting(
                value: .string("codex"),
                source: "file",
                tier: 1,
                editable: true,
                pendingValue: .string("claude_code")
            )
        )

        XCTAssertEqual(status.displayedString(fileValue: "claude_code"), "claude_code")
        XCTAssertEqual(status.pendingDescription, "claude_code")
    }
}
