import Foundation
import XCTest
@testable import AgentRoomClient

final class SketchCompatibilityTests: XCTestCase {
    func testHistoricalTranscriptRetainsSketchSelection() throws {
        let data = Data("""
        {
          "id": "message-old", "sessionId": "session-old", "turnId": "turn-old",
          "role": "user", "content": "Explain this selection", "status": "completed",
          "at": "2026-09-16T00:00:00.000Z",
          "context": {
            "paths": ["README.md"],
            "sketch": {"sketchId": "sketch-old", "revision": 4, "objectIds": ["box-1"]}
          }
        }
        """.utf8)
        let message = try JSONDecoder().decode(AgentSessionMessage.self, from: data)
        XCTAssertEqual(message.context?.paths, ["README.md"])
        XCTAssertEqual(message.context?.sketch?.sketchId, "sketch-old")
        XCTAssertEqual(message.context?.sketch?.revision, 4)
        XCTAssertEqual(message.context?.sketch?.objectIds, ["box-1"])
    }
}
