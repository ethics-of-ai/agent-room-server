import Foundation
import XCTest
@testable import AgentRoomClient

/// The live agent sketch fields: who changed a sketch, and whether a thread
/// has the sketch tools.
final class SketchAgentEventTests: XCTestCase {
    func testDecodesAnAgentChangeWithItsSessionAndTurn() throws {
        let json = #"{"id":"e1","type":"sketch_document_changed","at":"2026-10-09T00:00:00.000Z","payload":{"workspaceId":"w","path":"docs/sketches/board.sketch.json","sketchId":"sketch-1","revision":4,"kind":"commit","actorKind":"agent","sessionId":"agent-session-1","turnId":"agent-turn-1"}}"#
        let event = try JSONDecoder().decode(AgentRoomEvent.self, from: Data(json.utf8))
        let change = try XCTUnwrap(SketchDocumentChangedEvent(event: event))
        XCTAssertEqual(change.actorKind, .agent)
        XCTAssertEqual(change.sessionId, "agent-session-1")
        XCTAssertEqual(change.turnId, "agent-turn-1")
        XCTAssertEqual(change.revision, 4)
        XCTAssertEqual(change.path, "docs/sketches/board.sketch.json")
    }

    func testAHumanChangeCarriesNoThread() throws {
        let payload: JSONValue = .object([
            "workspaceId": .string("w"), "path": .string("a.sketch.json"), "sketchId": .string("s"),
            "revision": .number(2), "kind": .string("undo"), "actorKind": .string("human")
        ])
        let change = try XCTUnwrap(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t", payload: payload)))
        XCTAssertEqual(change.actorKind, .human)
        XCTAssertNil(change.sessionId)
        XCTAssertNil(change.turnId)
    }

    func testUnknownKindsAndActorsStillRouteAsAChange() throws {
        let payload: JSONValue = .object([
            "workspaceId": .string("w"), "path": .string("a.sketch.json"), "kind": .string("renamed"), "actorKind": .string("robot")
        ])
        let change = try XCTUnwrap(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t", payload: payload)))
        XCTAssertEqual(change.kind, .renamed)
        XCTAssertNil(change.actorKind)
        let newer = try XCTUnwrap(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t",
            payload: .object(["workspaceId": .string("w"), "path": .string("a.sketch.json"), "kind": .string("archived")]))))
        XCTAssertNil(newer.kind)
        XCTAssertNil(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "workspace_file_written", at: "t", payload: payload)))
        XCTAssertNil(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t", payload: .object(["workspaceId": .string("w")]))))
    }

    func testDecodesSketchToolsAvailabilityAndItsAbsence() throws {
        let base = #""id":"s","workspaceId":"w","workspacePath":"/w","runnerKind":"codex","status":"idle","turnCount":0,"createdAt":"t","updatedAt":"t""#
        let current = try JSONDecoder().decode(AgentSession.self, from: Data("{\(base),\"sketchToolsAvailable\":true}".utf8))
        XCTAssertEqual(current.sketchToolsAvailable, true)
        let older = try JSONDecoder().decode(AgentSession.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(older.sketchToolsAvailable)
    }
}

final class SketchIndexContractTests: XCTestCase {
    func testDecodesTheIndexAndTheFlag() throws {
        let json = #"{"sketches":[{"path":"docs/a.sketch.json","title":"a","state":"ok","sketchId":"sketch-a","revision":3,"objectCount":2,"lastChangedAt":"2026-10-09T00:00:00.000Z","lastActorKind":"agent"},{"path":"b.sketch.json","title":"b","state":"invalid","invalidReason":"invalid_document"}],"total":2,"truncated":false,"limit":200}"#
        let response = try JSONDecoder().decode(SketchIndexResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.sketches.map(\.path), ["docs/a.sketch.json", "b.sketch.json"])
        XCTAssertEqual(response.sketches[0].lastActorKind, "agent")
        XCTAssertEqual(response.sketches[1].invalidReason, "invalid_document")
        let config = try JSONDecoder().decode(PublicServiceConfig.self, from: Data(#"{"runnerKind":"codex","requireAuth":false,"sketchIndex":true}"#.utf8))
        XCTAssertEqual(config.sketchIndex, true)
        let older = try JSONDecoder().decode(PublicServiceConfig.self, from: Data(#"{"runnerKind":"codex","requireAuth":false}"#.utf8))
        XCTAssertNil(older.sketchIndex)
    }
}

final class SketchLifecycleEventTests: XCTestCase {
    func testDecodesARenameWithItsPreviousPathAndADelete() throws {
        let renamed = AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t", payload: .object([
            "workspaceId": .string("w"), "path": .string("new.sketch.json"), "kind": .string("renamed"),
            "previousPath": .string("old.sketch.json"), "actorKind": .string("agent")
        ]))
        let change = try XCTUnwrap(SketchDocumentChangedEvent(event: renamed))
        XCTAssertEqual(change.kind, .renamed)
        XCTAssertEqual(change.previousPath, "old.sketch.json")
        // An older client's routing reads only the type and workspace, which a
        // rename or delete still carries, so it re-reads as for any change.
        XCTAssertEqual(renamed.payload.objectValue?["workspaceId"]?.stringValue, "w")
        let deleted = try XCTUnwrap(SketchDocumentChangedEvent(event: AgentRoomEvent(id: "e", type: "sketch_document_changed", at: "t",
            payload: .object(["workspaceId": .string("w"), "path": .string("gone.sketch.json"), "kind": .string("deleted")]))))
        XCTAssertEqual(deleted.kind, .deleted)
        XCTAssertNil(deleted.previousPath)
        XCTAssertNil(deleted.revision)
    }
}

final class SketchHistoryHeadTests: XCTestCase {
    func testDecodesHistoryHeadsOnReadsAndOutcomes() throws {
        let read = #"{"sketchId":"s","revision":3,"document":{"schemaVersion":3,"kind":"sketch","sketchId":"s","revision":3,"objects":[]},"undoDepth":2,"redoDepth":0,"undoHead":{"label":"align boxes","actorKind":"agent"},"redoHead":null}"#
        let snapshot = try JSONDecoder().decode(SketchSessionSnapshot.self, from: Data(read.utf8))
        XCTAssertEqual(snapshot.undoHead, SketchHistoryHead(label: "align boxes", actorKind: .agent))
        XCTAssertTrue(snapshot.undoHead?.isAgent == true)
        XCTAssertNil(snapshot.redoHead)
        let outcome = #"{"receipt":{"requestId":"r","transactionId":"tx-4","revision":4,"kind":"undo","actor":{"kind":"human"},"label":"Undo","requestFingerprint":"aaaa"},"revision":4,"undoDepth":1,"redoDepth":1,"redoHead":{"label":"align boxes","actorKind":"agent"}}"#
        let decoded = try JSONDecoder().decode(SketchTransactionOutcome.self, from: Data(outcome.utf8))
        XCTAssertEqual(decoded.redoHead?.label, "align boxes")
        XCTAssertNil(decoded.undoHead)
        let newer = try JSONDecoder().decode(SketchHistoryHead.self, from: Data(#"{"label":"tidy","actorKind":"robot"}"#.utf8))
        XCTAssertNil(newer.actorKind)
        XCTAssertFalse(newer.isAgent)
    }
}
