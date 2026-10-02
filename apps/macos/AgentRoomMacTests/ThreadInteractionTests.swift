import XCTest
@testable import AgentRoomMac

final class ThreadInteractionTests: XCTestCase {
    func testSearchIsTrimmedCaseInsensitiveAndKeepsSourceOrder() {
        let sessions = [session("new", title: "Fix parser"), session("old", title: "Other")]
        XCTAssertEqual(ThreadStatusFilter.all.sessions(in: sessions, query: "  PARSER \n").map(\.id), ["new"])
        XCTAssertEqual(ThreadStatusFilter.all.sessions(in: sessions, query: "workspace").map(\.id), ["new", "old"])
        XCTAssertEqual(ThreadStatusFilter.all.sessions(in: sessions, query: "CODEX").count, 2)
        XCTAssertEqual(ThreadStatusFilter.all.sessions(in: sessions, query: " ").map(\.id), ["new", "old"])
    }

    func testRunningWinsOverIdleAndFailedAndAllKeepsUnknown() {
        let idleWithTurn = session("one", status: "IDLE", activeTurn: "turn")
        let failedWithTurn = session("two", status: "failed", activeTurn: "turn")
        let unknown = session("three", status: "future-status")
        XCTAssertTrue(ThreadStatusFilter.running.matches(idleWithTurn))
        XCTAssertFalse(ThreadStatusFilter.idle.matches(idleWithTurn))
        XCTAssertFalse(ThreadStatusFilter.failed.matches(failedWithTurn))
        XCTAssertTrue(ThreadStatusFilter.failed.matches(session("four", status: "FAILED")))
        XCTAssertTrue(ThreadStatusFilter.all.matches(unknown))
        XCTAssertFalse(ThreadStatusFilter.running.matches(unknown))
    }

    func testSelectionSurvivesSortingFilteringAndRemoval() {
        var selection = ThreadSelectionState()
        selection.reconcile(availableIDs: [])
        XCTAssertNil(selection.id)
        selection.reconcile(availableIDs: ["one", "two"])
        XCTAssertEqual(selection.id, "one")
        selection.select("two")
        selection.reconcile(availableIDs: ["two", "one"])
        selection.select(nil)
        selection.reconcile(availableIDs: ["one"])
        XCTAssertEqual(selection.id, "two")
        selection.reconcile(availableIDs: [])
        XCTAssertEqual(selection.id, "two")
        selection.select("three")
        XCTAssertEqual(selection.id, "three")
    }

    func testFollowingHandlesAppendAndGrowthUntilUserScrollsAway() {
        var reading = ThreadReadingState()
        XCTAssertTrue(reading.contentChanged(retainedIDs: ["one"]))
        XCTAssertTrue(reading.contentChanged(retainedIDs: ["one"]))
        reading.anchorID = "one"
        reading.userScrolled(distanceToBottom: 100)
        XCTAssertFalse(reading.contentChanged(retainedIDs: ["one", "two"]))
        XCTAssertEqual(reading.anchorID, "one")
        reading.userScrolled(distanceToBottom: ThreadReadingState.bottomTolerance)
        XCTAssertTrue(reading.isFollowing)
        reading.userScrolled(distanceToBottom: ThreadReadingState.bottomTolerance + 1)
        XCTAssertFalse(reading.isFollowing)
        reading.anchorID = "one"
        reading.jumpToLatest()
        XCTAssertTrue(reading.isFollowing)
        XCTAssertNil(reading.anchorID)
    }

    func testDroppedEventAnchorDoesNotResumeFollowing() {
        var reading = ThreadReadingState()
        reading.anchorID = "old-event"
        reading.userScrolled(distanceToBottom: 300)
        XCTAssertFalse(reading.contentChanged(retainedIDs: ["new-event"]))
        XCTAssertNil(reading.anchorID)
        XCTAssertFalse(reading.isFollowing)
    }

    func testTranscriptAndEventsHaveIndependentReadingState() {
        var transcript = ThreadReadingState()
        let events = ThreadReadingState()
        transcript.userScrolled(distanceToBottom: 90)
        XCTAssertFalse(transcript.isFollowing)
        XCTAssertTrue(events.isFollowing)
        XCTAssertTrue(ThreadReadingState().isFollowing)
    }

    func testNativeScrollPausesFollowingDuringUserInputAndResumesAtBottom() {
        var reading = ThreadReadingState()
        reading.scrollPhaseChanged(isUserScrolling: true, distanceToBottom: 0)
        XCTAssertTrue(reading.isFollowing)
        XCTAssertFalse(reading.contentChanged(retainedIDs: ["one"]))
        reading.scrollPhaseChanged(isUserScrolling: false, distanceToBottom: 0)
        XCTAssertTrue(reading.shouldFollowUpdates)
    }

    func testNativeScrollEndRetainsPausedAnchorAndProgrammaticMovementDoesNotResume() {
        var reading = ThreadReadingState()
        reading.scrollPhaseChanged(isUserScrolling: true, distanceToBottom: 100)
        reading.anchorID = "one"
        reading.scrollPhaseChanged(isUserScrolling: false, distanceToBottom: 100)
        reading.scrollPhaseChanged(isUserScrolling: false, distanceToBottom: 0)
        XCTAssertFalse(reading.shouldFollowUpdates)
        XCTAssertEqual(reading.anchorID, "one")
    }

    private func session(_ id: String, title: String = "Title", status: String = "idle",
                         activeTurn: String? = nil) -> AgentSession {
        AgentSession(id: id, workspaceId: "workspace", workspacePath: "/tmp/workspace", runnerKind: "codex",
                     title: title, status: status, activeTurnId: activeTurn, lastMessage: nil, error: nil,
                     turnCount: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z")
    }
}
