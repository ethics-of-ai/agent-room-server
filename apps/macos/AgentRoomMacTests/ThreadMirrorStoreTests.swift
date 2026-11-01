import XCTest
@testable import AgentRoomMac

@MainActor
final class ThreadMirrorStoreTests: XCTestCase {
    func testFailedRefreshRetainsDataAndRemovedSelectionStaysUnavailable() async {
        let store = BackendThreadMirrorStore()
        await store.refresh(using: ThreadMirrorFixtureURLProtocol.apiClient(scenario: "initial"))
        XCTAssertNil(store.lastError)
        XCTAssertEqual(store.selectedSessionID, "one")
        XCTAssertEqual(store.sessions.count, 1)
        await store.refresh(using: ThreadMirrorFixtureURLProtocol.apiClient(scenario: "failure"))
        XCTAssertNotNil(store.lastError)
        XCTAssertEqual(store.selectedSession?.id, "one")
        XCTAssertEqual(store.sessions.count, 1)
        await store.refresh(using: ThreadMirrorFixtureURLProtocol.apiClient(scenario: "removed"))
        XCTAssertNil(store.lastError)
        XCTAssertEqual(store.selectedSessionID, "one")
        XCTAssertNil(store.selectedSession)
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testChildrenSitIndentedRightAfterTheirParent() async {
        let store = BackendThreadMirrorStore()
        await store.refresh(using: ThreadMirrorFixtureURLProtocol.apiClient(scenario: "family"))
        XCTAssertNil(store.lastError)
        // Newest first is child-open, other, parent, child-closed, orphan; the
        // children move under their parent and the orphan keeps its place.
        let rows = store.listRows(showing: store.sessions)
        XCTAssertEqual(rows.map(\.id), ["other", "parent", "child-open", "child-closed", "orphan"])
        XCTAssertEqual(rows.map(\.isIndented), [false, false, true, true, false])
        XCTAssertEqual(rows.map(\.parentLine), [nil, nil, "Child of Parent", "Closed child of Parent", "Closed child thread"])
    }

    func testAChildWhoseParentIsFilteredOutKeepsItsOwnPlace() async {
        let store = BackendThreadMirrorStore()
        await store.refresh(using: ThreadMirrorFixtureURLProtocol.apiClient(scenario: "family"))
        let running = ThreadStatusFilter.running.sessions(in: store.sessions, query: "")
        let rows = store.listRows(showing: running)
        XCTAssertEqual(rows.map(\.id), ["child-open"])
        XCTAssertEqual(rows.first?.isIndented, false)
        XCTAssertEqual(rows.first?.parentLine, "Child of Parent")

        let searched = store.listRows(showing: ThreadStatusFilter.all.sessions(in: store.sessions, query: "child"))
        XCTAssertEqual(searched.map(\.id), ["child-open", "child-closed"])
        XCTAssertEqual(searched.map(\.isIndented), [false, false])
    }
}
