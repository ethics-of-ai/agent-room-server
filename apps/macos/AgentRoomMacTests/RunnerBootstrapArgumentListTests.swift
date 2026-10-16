import XCTest
@testable import AgentRoomMac

/// The Mac reads the first argument the way the backend's `listEnv` does, so a
/// check here names the entrypoint the backend will launch.
final class RunnerBootstrapArgumentListTests: XCTestCase {
    func testFirstArgumentIsTrimmedAndSkipsEmptyItems() {
        XCTAssertEqual(RunnerBootstrapArgumentList.first(in: "/a/bin.js,--flag"), "/a/bin.js")
        XCTAssertEqual(RunnerBootstrapArgumentList.first(in: " /a/bin.js , --flag"), "/a/bin.js")
        XCTAssertEqual(RunnerBootstrapArgumentList.first(in: ",,/a/bin.js"), "/a/bin.js")
    }

    func testNoArgumentIsNil() {
        XCTAssertNil(RunnerBootstrapArgumentList.first(in: nil))
        XCTAssertNil(RunnerBootstrapArgumentList.first(in: ""))
        XCTAssertNil(RunnerBootstrapArgumentList.first(in: " , "))
    }
}
