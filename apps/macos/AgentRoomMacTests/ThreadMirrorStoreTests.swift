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
}
