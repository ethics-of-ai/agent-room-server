import Foundation
import XCTest
@testable import AgentRoomClient

final class SketchPieceContractTests: XCTestCase {
    func testVersionFourDocumentDecodesTableAndPieces() throws {
        let data = Data("""
        {
          "schemaVersion": 4, "kind": "sketch", "sketchId": "town", "revision": 3,
          "table": {"cellSize": 0.08, "cells": 10},
          "objects": [
            {"id": "base", "kind": "piece", "catalogId": "block.cube", "cell": [2, 1], "level": 0, "rotation": 0},
            {"id": "sign", "kind": "piece", "catalogId": "block.label", "cell": [3, 1], "level": 0, "rotation": 3,
             "color": "#C8553D", "text": "Main St"}
          ]
        }
        """.utf8)
        let document = try JSONDecoder().decode(SketchDocumentSnapshot.self, from: data)
        XCTAssertEqual(document.table, SketchTable(cellSize: 0.08, cells: 10))
        XCTAssertEqual(document.objects[0].catalogId, "block.cube")
        XCTAssertEqual(document.objects[0].cell, [2, 1])
        XCTAssertEqual(document.objects[1].level, 0)
        XCTAssertEqual(document.objects[1].rotation, 3)
        XCTAssertEqual(document.objects[1].text, "Main St")
        XCTAssertTrue(document.objects[0].isKnownKind)
    }

    func testCellSizeGivesTheBackendsBoardWidth() {
        XCTAssertEqual(SketchTable.standard, SketchTable(cellSize: 0.05, cells: 16))
        XCTAssertEqual(SketchTable.cells(for: SketchTable.minimumCellSize), 40)
        XCTAssertEqual(SketchTable.cells(for: SketchTable.maximumCellSize), 4)
        XCTAssertEqual(SketchTable.cells(for: 0.03), 27)
        XCTAssertEqual(SketchTable(cellSize: 0.08).cells, 10)
    }

    func testDocumentWithoutTableDecodesAsNil() throws {
        let data = Data(#"{"schemaVersion": 3, "kind": "sketch", "sketchId": "old", "revision": 0, "objects": []}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(SketchDocumentSnapshot.self, from: data).table)
    }

    func testPieceOperationsEncodeOnlyStrictSchemaKeys() throws {
        let create = SketchCommitOperation.create(SketchObjectCreation(
            objectId: "base", kind: "piece", color: "#4F7CAC", catalogId: "block.cube", cell: [0, 1], rotation: 2
        ))
        XCTAssertEqual(try encodedObject(create), [
            "op": "create", "objectId": "base", "kind": "piece", "color": "#4F7CAC",
            "catalogId": "block.cube", "cell": [0, 1], "rotation": 2
        ] as NSDictionary)

        let move = SketchCommitOperation.update(SketchObjectUpdate(objectId: "base", kind: "piece", cell: [4, 4]))
        XCTAssertEqual(try encodedObject(move), ["op": "update", "objectId": "base", "kind": "piece", "cell": [4, 4]] as NSDictionary)
    }

    func testSetTableEncodesNullToRemoveTheTable() throws {
        XCTAssertEqual(try encodedObject(.setTable(cellSize: 0.04)), ["op": "setTable", "cellSize": 0.04] as NSDictionary)
        XCTAssertEqual(try encodedObject(.setTable(cellSize: nil)), ["op": "setTable", "cellSize": NSNull()] as NSDictionary)
    }

    func testCatalogResolvesKnownIdsAndFallsBackForUnknownOnes() {
        XCTAssertEqual(SketchPieceCatalogEntry.entry(for: "block.wall").levels, 2)
        XCTAssertTrue(SketchPieceCatalogEntry.entry(for: "block.cylinder").stacksOnTop)
        XCTAssertEqual(SketchPieceCatalogEntry.entry(for: "block.pipe-angle").ends, [.front, .right])
        XCTAssertTrue(SketchPieceCatalogEntry.entry(for: "block.pipe").setsFlow)
        XCTAssertEqual(SketchPieceCatalogEntry.unknown.ends, [])
        XCTAssertEqual(SketchPieceCatalogEntry.entry(for: "block.tree"), .unknown)
        XCTAssertFalse(SketchPieceCatalogEntry.isKnown("block.tree"))
    }

    func testEdgesTurnClockwiseSeenFromAbove() {
        XCTAssertEqual(SketchPieceEdge.back.turned(quarterTurns: 1), .right)
        XCTAssertEqual(SketchPieceEdge.left.turned(quarterTurns: 1), .back)
        XCTAssertEqual(SketchPieceEdge.front.turned(quarterTurns: 2), .back)
        XCTAssertEqual(SketchPieceEdge.right.turned(quarterTurns: -1), .back)
        XCTAssertEqual(SketchPieceEdge.left.quarterTurnsFromBack, 3)
    }

    private func encodedObject(_ operation: SketchCommitOperation) throws -> NSDictionary {
        let data = try JSONEncoder().encode(operation)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
}
