import XCTest
@testable import AgentRoomClient

final class WorkspaceMediaKindTests: XCTestCase {
    @available(*, deprecated, message: "Exercises the deprecated source-compatibility accessor.")
    func testDeprecatedMaximumDownloadBytesRemainsEffectivelyUncapped() {
        for kind in WorkspaceMediaKind.allCases {
            XCTAssertEqual(kind.maximumDownloadBytes, Int64.max)
        }
    }
}
