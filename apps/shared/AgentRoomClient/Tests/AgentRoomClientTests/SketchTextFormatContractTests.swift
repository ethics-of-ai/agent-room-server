import Foundation
import XCTest
@testable import AgentRoomClient

final class SketchTextFormatContractTests: XCTestCase {
    private let formattedTextBox = #"""
    {"id":"note","kind":"textBox","text":"Plan\nShip","color":"#1C1C1EFF",
     "font":{"family":"serif","size":0.02},
     "paragraphs":[{"style":"title","alignment":"center","list":"none"},{"style":"body","alignment":"leading","list":"bullet"}],
     "spans":[{"start":0,"length":4,"bold":true,"underline":true}],
     "rendering":"extruded","extrusionDepth":0.03,
     "size":[0.4,0.15],"appearance":"fill","fillColor":"#FFFFFFFF","outlineColor":"#000000FF","outlineWidth":0.004}
    """#

    func testSnapshotDecodesFormatting() throws {
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(formattedTextBox.utf8))
        XCTAssertEqual(object.font, SketchTextFont(family: .serif, size: 0.02))
        XCTAssertEqual(object.paragraphs, [
            SketchTextParagraph(style: .title, alignment: .center, list: .none),
            SketchTextParagraph(style: .body, alignment: .leading, list: .bullet)
        ])
        XCTAssertEqual(object.spans, [SketchTextSpan(start: 0, length: 4, bold: true, underline: true)])
        XCTAssertEqual(object.rendering, .extruded)
        XCTAssertEqual(object.extrusionDepth, 0.03)
        XCTAssertTrue(object.hasSupportedTextFormat)
    }

    func testVersionTwoSnapshotHasNoFormatting() throws {
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(#"""
        {"id":"note","kind":"textBox","text":"Hi","size":[0.1,0.1],"appearance":"fill","fillColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0.004}
        """#.utf8))
        XCTAssertNil(object.font)
        XCTAssertNil(object.paragraphs)
        XCTAssertTrue(object.hasSupportedTextFormat)
    }

    func testUnknownValuesDecodeAsUnsupportedAndEncodeUnchanged() throws {
        let newer = formattedTextBox
            .replacingOccurrences(of: #""family":"serif""#, with: #""family":"script""#)
            .replacingOccurrences(of: #""style":"title""#, with: #""style":"subtitle""#)
            .replacingOccurrences(of: #""rendering":"extruded""#, with: #""rendering":"hologram""#)
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(newer.utf8))
        XCTAssertEqual(object.font?.family, .unsupported("script"))
        XCTAssertEqual(object.paragraphs?.first?.style, .unsupported("subtitle"))
        XCTAssertEqual(object.rendering, .unsupported("hologram"))
        XCTAssertFalse(object.hasSupportedTextFormat)

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(object)) as? [String: Any]
        XCTAssertEqual((encoded?["font"] as? [String: Any])?["family"] as? String, "script")
        XCTAssertEqual(encoded?["rendering"] as? String, "hologram")
    }

    func testTextOnlyBoxRoundTripsTheNoneAppearance() throws {
        let textOnly = formattedTextBox.replacingOccurrences(of: #""appearance":"fill""#, with: #""appearance":"none""#)
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(textOnly.utf8))
        XCTAssertEqual(object.appearance, SketchShapeAppearance.none)
        XCTAssertFalse(SketchShapeAppearance.none.includesFill)
        XCTAssertFalse(SketchShapeAppearance.none.includesOutline)
        XCTAssertFalse(SketchShapeAppearance.visiblePartCases.contains(.none))

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(object)) as? [String: Any]
        XCTAssertEqual(encoded?["appearance"] as? String, "none")
    }

    func testSpanEncodesOnlyFlagsThatAreOn() throws {
        let data = try JSONEncoder().encode(SketchTextSpan(start: 2, length: 3, italic: true))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(encoded.keys), ["start", "length", "italic"])
        XCTAssertEqual(try JSONDecoder().decode(SketchTextSpan.self, from: data), SketchTextSpan(start: 2, length: 3, italic: true))
    }

    func testUpdateCarriesFormattingAndOmitsAbsentFields() throws {
        let update = SketchObjectUpdate(
            objectId: "note",
            kind: "textBox",
            text: "A\nB",
            paragraphs: SketchTextParagraph.plainParagraphs(for: "A\nB"),
            spans: []
        )
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) as? [String: Any])
        XCTAssertEqual((encoded["paragraphs"] as? [[String: String]])?.count, 2)
        XCTAssertEqual((encoded["spans"] as? [Any])?.count, 0)
        XCTAssertNil(encoded["font"])
        XCTAssertNil(encoded["rendering"])
    }

    func testPlainParagraphsCountEmptyLines() {
        XCTAssertEqual(SketchTextParagraph.plainParagraphs(for: "One\n\nThree\n").count, 4)
        XCTAssertEqual(SketchTextParagraph.plainParagraphs(for: "One"), [.plain])
    }

    /// The backend splits paragraphs at every `\n` code unit, including the
    /// one inside a `\r\n` grapheme.
    func testPlainParagraphsCountTheNewlineInsideCRLF() {
        XCTAssertEqual(SketchTextParagraph.plainParagraphs(for: "a\r\nb").count, 2)
    }
}
