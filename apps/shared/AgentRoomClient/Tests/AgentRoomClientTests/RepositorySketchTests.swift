import Foundation
import XCTest
@testable import AgentRoomClient

final class RepositorySketchTests: XCTestCase {
    private func client(body: String = "{\"sketch\":null}", status: Int = 200) -> APIClient {
        SketchURLProtocol.body = Data(body.utf8)
        SketchURLProtocol.status = status
        SketchURLProtocol.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SketchURLProtocol.self]
        return APIClient(serverBaseURL: URL(string: "http://example.test/bridge")!, authToken: "test-token", urlSession: URLSession(configuration: config))
    }

    private func encodedObject(_ operation: SketchCommitOperation) throws -> [String: Any] {
        let data = try JSONEncoder().encode(operation)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return object
    }

    private let snapshot = #"{"sketch":{"workspaceId":"ws","path":"a.sketch.json","sketchId":"sketch-1","revision":3,"document":{"schemaVersion":2,"kind":"sketch","sketchId":"sketch-1","revision":3,"objects":[]},"fileVersion":"abc","undoDepth":2,"redoDepth":0,"historyReset":true,"outcomeUnknown":false}}"#

    private func sender(body: String = "{\"sketch\":null}", status: Int = 200) -> RepositorySketchSender {
        RepositorySketchSender(client: client(body: body, status: status), workspaceId: "ws", path: "docs/a & b.sketch.json")
    }

    func testReadUsesWorkspacePathRouteAndDecodesWithoutLegacyTimestamps() async throws {
        let response = try await sender(body: snapshot).fetchSketch()
        XCTAssertEqual(response.sketch?.path, "a.sketch.json")
        XCTAssertEqual(response.sketch?.fileVersion, "abc")
        XCTAssertEqual(response.sketch?.historyReset, true)
        XCTAssertNil(response.sketch?.createdAt)
        let request = try XCTUnwrap(SketchURLProtocol.requests.last)
        let url = try XCTUnwrap(request.url)
        XCTAssertEqual(url.path, "/bridge/api/workspaces/ws/sketch")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "docs/a & b.sketch.json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
    }

    func testHistoryResetPostsTheFileVersionForThePath() async throws {
        _ = try await sender(body: snapshot).resetSketchHistory(fileVersion: "abc")
        let url = try XCTUnwrap(SketchURLProtocol.requests.last?.url)
        XCTAssertEqual(url.path, "/bridge/api/workspaces/ws/sketch/reset-history")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "docs/a & b.sketch.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: SketchURLProtocol.lastBody!) as? [String: String])
        XCTAssertEqual(object, ["fileVersion": "abc"])
    }

    func testCreationCarriesTheChosenNameToTheWorkspace() async throws {
        let api = client(body: snapshot)
        _ = try await api.createRepositorySketch(workspaceId: "ws", name: "My drawing")
        let request = try XCTUnwrap(SketchURLProtocol.requests.last)
        XCTAssertEqual(request.url?.path, "/bridge/api/workspaces/ws/sketch")
        XCTAssertEqual(request.httpMethod, "POST")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: SketchURLProtocol.lastBody!) as? [String: String])
        XCTAssertEqual(object, ["name": "My drawing"])
    }

    func testClearEncodesAsOneOperation() throws {
        let data = try JSONEncoder().encode(SketchCommitOperation.clear)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String], ["op": "clear"])
    }

    func testCommitAndHistoryEncodeBothLocksWithoutTurnOrActor() throws {
        let commit = SketchCommitRequest(requestId: "gesture-1", baseRevision: 3, fileVersion: "token", operations: [.delete(objectId: "box")])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(commit)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["requestId", "baseRevision", "fileVersion", "operations"])
        XCTAssertEqual(object["fileVersion"] as? String, "token")
        let history = SketchUndoRedoRequest(requestId: "undo-1", baseRevision: 3, fileVersion: "token")
        let historyObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(history)) as? [String: Any])
        XCTAssertEqual(Set(historyObject.keys), ["requestId", "baseRevision", "fileVersion"])
    }

    func testStrokeBrushAndLineStyleDecodeAndEncode() throws {
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(#"{"id":"stroke","kind":"stroke","points":[[0,0,0],[0.1,0,0]],"width":0.02,"brush":"broadMarker","lineStyle":"dotted"}"#.utf8))
        XCTAssertEqual(object.brush, .broadMarker)
        XCTAssertEqual(object.lineStyle, .dotted)

        let operation = SketchCommitOperation.create(SketchObjectCreation(
            objectId: "stroke",
            kind: "stroke",
            points: [[0, 0, 0], [0.1, 0, 0]],
            width: 0.02,
            brush: .broadMarker,
            lineStyle: .dashed
        ))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(operation)) as? [String: Any])
        XCTAssertEqual(encoded["brush"] as? String, "broadMarker")
        XCTAssertEqual(encoded["lineStyle"] as? String, "dashed")
    }

    func testHighlighterBrushRoundTrips() throws {
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(##"{"id":"stroke","kind":"stroke","points":[[0,0,0],[0.1,0,0]],"width":0.03,"brush":"highlighter","lineStyle":"solid","color":"#F9A82566"}"##.utf8))
        XCTAssertEqual(object.brush, .highlighter)
        XCTAssertEqual(try JSONEncoder().encode(SketchStrokeBrush.highlighter), Data(#""highlighter""#.utf8))
    }

    func testOlderStrokePayloadStillDecodesWithoutStyleFields() throws {
        let object = try JSONDecoder().decode(SketchObjectSnapshot.self, from: Data(#"{"id":"stroke","kind":"stroke","points":[[0,0,0],[0.1,0,0]],"width":0.008}"#.utf8))
        XCTAssertNil(object.brush)
        XCTAssertNil(object.lineStyle)
    }

    func testPlanarShapePayloadDecodesAndEncodesIndependentAppearance() throws {
        let object = try JSONDecoder().decode(
            SketchObjectSnapshot.self,
            from: Data(##"{"id":"shape-1","kind":"planarShape","shapeType":"ellipse","size":[0.4,0.2],"appearance":"fillAndOutline","fillColor":"#12ab34cc","outlineColor":"#112233","outlineWidth":0.012}"##.utf8)
        )
        XCTAssertEqual(object.shapeType, .ellipse)
        XCTAssertEqual(object.appearance, .fillAndOutline)
        XCTAssertEqual(object.fillColor, "#12ab34cc")
        XCTAssertEqual(object.outlineColor, "#112233")

        let operation = SketchCommitOperation.create(SketchObjectCreation(
            objectId: "shape-1",
            kind: "planarShape",
            shapeType: .triangle,
            appearance: .outline,
            fillColor: "#abcdef",
            outlineColor: "#fedcba80",
            outlineWidth: 0.008,
            size: [0.3, 0.2]
        ))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(operation)) as? [String: Any])
        XCTAssertEqual(encoded["kind"] as? String, "planarShape")
        XCTAssertEqual(encoded["shapeType"] as? String, "triangle")
        XCTAssertEqual(encoded["appearance"] as? String, "outline")
        XCTAssertEqual(encoded["fillColor"] as? String, "#abcdef")
        XCTAssertEqual(encoded["outlineColor"] as? String, "#fedcba80")
        XCTAssertEqual(encoded["outlineWidth"] as? Double, 0.008)
        XCTAssertEqual(encoded["size"] as? [Double], [0.3, 0.2])
    }

    func testTextBoxPayloadAndOperationsCarryContentAndPanelAppearance() throws {
        let object = try JSONDecoder().decode(
            SketchObjectSnapshot.self,
            from: Data(##"{"id":"note-1","kind":"textBox","text":"A note","color":"#112233cc","size":[0.3,0.2],"appearance":"fillAndOutline","fillColor":"#44556680","outlineColor":"#778899","outlineWidth":0.004}"##.utf8)
        )
        XCTAssertTrue(object.isKnownKind)
        XCTAssertEqual(object.kind, "textBox")
        XCTAssertEqual(object.text, "A note")
        XCTAssertEqual(object.color, "#112233cc")
        XCTAssertEqual(object.size, [0.3, 0.2])
        XCTAssertEqual(object.appearance, .fillAndOutline)
        XCTAssertEqual(object.fillColor, "#44556680")

        let creation = try XCTUnwrap(encodedObject(.create(SketchObjectCreation(
            objectId: "note-1",
            kind: "textBox",
            appearance: .outline,
            fillColor: "#102030",
            outlineColor: "#405060",
            outlineWidth: 0.008,
            size: [0.4, 0.2],
            text: "A note",
            color: "#abcdef"
        ))))
        XCTAssertEqual(creation["kind"] as? String, "textBox")
        XCTAssertEqual(creation["text"] as? String, "A note")
        XCTAssertEqual(creation["color"] as? String, "#abcdef")
        XCTAssertEqual(creation["size"] as? [Double], [0.4, 0.2])
        XCTAssertEqual(creation["appearance"] as? String, "outline")

        let update = try XCTUnwrap(encodedObject(.update(SketchObjectUpdate(
            objectId: "note-1",
            kind: "textBox",
            appearance: .fill,
            fillColor: "#111111",
            outlineColor: "#eeeeee",
            outlineWidth: 0.012,
            size: [0.5, 0.25],
            text: "Updated",
            color: "#fedcba"
        ))))
        XCTAssertEqual(update["kind"] as? String, "textBox")
        XCTAssertEqual(update["text"] as? String, "Updated")
        XCTAssertEqual(update["size"] as? [Double], [0.5, 0.25])
        XCTAssertEqual(update["fillColor"] as? String, "#111111")
    }

    func testChangedFileAndUnknownOutcomeRemainTypedErrors() async throws {
        for code in ["file_changed", "file_missing", "outcome_unknown"] {
            let file = sender(body: "{\"error\":\"Inspect file\",\"code\":\"\(code)\"}", status: 409)
            do {
                _ = try await file.fetchSketch()
                XCTFail("expected refusal")
            } catch let error as SketchEndpointError {
                XCTAssertEqual(error.code, code)
                XCTAssertEqual(error.isStaleRevision, code != "outcome_unknown")
            }
        }
    }

    func testRepositoryCapabilityIsExplicit() throws {
        let config = try JSONDecoder().decode(PublicServiceConfig.self, from: Data(#"{"runnerKind":"future","requireAuth":false,"repositorySketches":true}"#.utf8))
        XCTAssertEqual(config.repositorySketches, true)
        let old = try JSONDecoder().decode(PublicServiceConfig.self, from: Data(#"{"runnerKind":"future","requireAuth":false}"#.utf8))
        XCTAssertNil(old.repositorySketches)
    }
}

private final class SketchURLProtocol: URLProtocol {
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var lastBody: Data?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        Self.lastBody = request.httpBody
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(bytes, count: count)
            }
            stream.close()
            Self.lastBody = data
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
