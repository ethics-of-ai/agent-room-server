import XCTest
@testable import AgentRoomClient

final class WorkspaceFileOpenPolicyTests: XCTestCase {
    func testDecisionTable() {
        let cases: [(String, String?, Bool?, Bool, WorkspaceFileOpenDecision)] = [
            ("Art/logo.PNG", "image", false, false, .media(.image)),
            ("Docs/guide.PDF", nil, false, false, .media(.pdf)),
            ("Models/room.USDZ", "usdz", false, false, .media(.usdz)),
            ("Sources/App.swift", nil, true, false, .text),
            ("Sources/App.swift", nil, nil, true, .text),
            ("Archive.bin", nil, false, false, .unavailable),
            ("notes.txt", "pdf", true, false, .unsupportedMetadata(.kindMismatch(reported: .pdf, inferred: nil))),
            ("Archive.bin", "image", false, false, .unsupportedMetadata(.kindMismatch(reported: .image, inferred: nil))),
            (
                "Art/logo.png",
                "future-image",
                false,
                false,
                .unsupportedMetadata(.unknownKind("future-image"))
            ),
            (
                "Art/logo.png",
                "pdf",
                false,
                false,
                .unsupportedMetadata(.kindMismatch(reported: .pdf, inferred: .image))
            )
        ]

        for (path, mediaKind, previewable, pathOnly, expected) in cases {
            XCTAssertEqual(
                WorkspaceFileOpenPolicy.decision(
                    path: path,
                    mediaKind: mediaKind,
                    previewable: previewable,
                    pathOnly: pathOnly
                ),
                expected,
                path
            )
        }
    }

    func testUnknownMediaKindRemainsDecodableAndIsNotTreatedAsText() throws {
        let entry = try JSONDecoder().decode(
            WorkspaceFileIndexEntry.self,
            from: Data(#"{"path":"future.asset","name":"future.asset","previewable":true,"mediaKind":"spatial-v2"}"#.utf8)
        )

        XCTAssertEqual(entry.mediaKind, "spatial-v2")
        XCTAssertEqual(
            WorkspaceFileOpenPolicy.decision(
                path: entry.path,
                mediaKind: entry.mediaKind,
                previewable: entry.previewable
            ),
            .unsupportedMetadata(.unknownKind("spatial-v2"))
        )
    }
}
