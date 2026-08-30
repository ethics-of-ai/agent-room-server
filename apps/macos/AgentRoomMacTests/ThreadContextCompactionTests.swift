import XCTest
@testable import AgentRoomMac

/// What the Mac's thread mirror shows about where a runner auto-compacts.
///
/// The rule that matters here is the negative one: only a runner that publishes
/// a threshold gets a mark on the bar. Codex keeps its limit internal and Cursor
/// summarizes on a schedule it does not publish, so a line drawn at some
/// fraction of capacity for those would be a number this app made up, not a
/// reading of the thread.
final class ThreadContextCompactionTests: XCTestCase {
    func testMarksTheThresholdAsAShareOfTheContextWindow() {
        let session = session(
            modelContextWindowTokens: 1_000_000,
            contextWindowUsedTokens: 125_000,
            contextCompactionThresholdTokens: 600_000
        )

        XCTAssertEqual(session.threadContextCompactionFraction, 0.6)
        XCTAssertEqual(
            session.threadContextCompactionLabel,
            "475,000 tokens before compaction at 600,000"
        )
    }

    func testRunnerThatPublishesNoThresholdGetsNoMark() {
        let session = session(
            modelContextWindowTokens: 1_000_000,
            contextWindowUsedTokens: 125_000,
            contextCompactionThresholdTokens: nil
        )

        XCTAssertNil(session.threadContextCompactionFraction)
        XCTAssertNil(session.threadContextCompactionLabel)
    }

    /// The mark needs a window to sit on, but the sentence does not: it can
    /// still name the threshold when the capacity has not arrived yet.
    func testThresholdWithoutAContextWindowStillReportsTheNumber() {
        let session = session(
            modelContextWindowTokens: nil,
            contextWindowUsedTokens: nil,
            contextCompactionThresholdTokens: 600_000
        )

        XCTAssertNil(session.threadContextCompactionFraction)
        XCTAssertEqual(session.threadContextCompactionLabel, "Compacts at 600,000 tokens")
    }

    /// Zero headroom is a real reading of a turn that has reached the line, not
    /// a warning state this app invented. Nothing turns a fraction of the
    /// threshold into an "almost there" colour.
    func testHeadroomFloorsAtZeroOnceUsagePassesTheThreshold() {
        let session = session(
            modelContextWindowTokens: 1_000_000,
            contextWindowUsedTokens: 640_000,
            contextCompactionThresholdTokens: 600_000
        )

        XCTAssertEqual(
            session.threadContextCompactionLabel,
            "At the 600,000 token compaction threshold"
        )
    }

    private func session(
        modelContextWindowTokens: Int?,
        contextWindowUsedTokens: Int?,
        contextCompactionThresholdTokens: Int?
    ) -> AgentSession {
        AgentSession(
            id: "session-1",
            workspaceId: "workspace-1",
            workspacePath: "/tmp/workspace",
            runnerKind: "claude_code",
            modelContextWindowTokens: modelContextWindowTokens,
            contextWindowUsedTokens: contextWindowUsedTokens,
            contextCompactionThresholdTokens: contextCompactionThresholdTokens,
            title: nil,
            status: "idle",
            activeTurnId: nil,
            lastMessage: nil,
            error: nil,
            turnCount: 1,
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z"
        )
    }
}
