import XCTest
@testable import AgentRoomClient

final class JSONValueTests: XCTestCase {
    func testIntegerProjectionRequiresAnExactInRangeValue() {
        XCTAssertEqual(JSONValue.number(12).intValue, 12)
        XCTAssertNil(JSONValue.number(1.75).intValue)
        XCTAssertNil(JSONValue.number(1e100).intValue)
    }

    func testNumberTextPreservesFractionalAndLargeValues() {
        XCTAssertEqual(JSONValue.number(12).numberText, "12")
        XCTAssertEqual(JSONValue.number(1.75).numberText, "1.75")
        XCTAssertEqual(JSONValue.number(1e100).numberText, "1e+100")
    }
}
