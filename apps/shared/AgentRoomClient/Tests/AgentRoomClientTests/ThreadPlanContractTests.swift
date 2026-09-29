import Foundation
import XCTest
@testable import AgentRoomClient

final class ThreadPlanContractTests: XCTestCase {
    // apps/backend/test/threadPlanSwiftContract.test.ts validates the fixture
    // between these markers against the backend's stored-plan schema.
    // BEGIN PLAN READ FIXTURE
    private static let planReadFixture = """
    {"schemaVersion":1,"plan":{"id":"plan-5b0c1f5e-0d6e-4c43-9a55-1f0e8f7a3c21","revision":7,"objective":"Ship the 🚀 importer","completionCriteria":"Importer tests pass","steps":[{"id":"step-1","description":"Parse the manifest","status":"completed","outcome":"Parser handles 👩‍👩‍👧 names","lastBlocker":null},{"id":"step-2","description":"Wire the route","status":"blocked","outcome":null,"lastBlocker":"Needs the auth decision"}],"status":"blocked","createdAt":"2026-09-28T01:00:00.000Z","updatedAt":"2026-09-28T01:05:00.000Z","lastModifiedTurnId":"agent-turn-a","executionTurnId":null,"pauseReason":null,"resumeNote":null,"summary":null}}
    """
    // END PLAN READ FIXTURE

    func testDecodesPlanReadAndPreservesEmojiText() throws {
        let response = try decode(Self.planReadFixture)
        let plan = try XCTUnwrap(response.plan)
        XCTAssertEqual(response.schemaVersion, 1)
        XCTAssertEqual(plan.revision, 7)
        XCTAssertEqual(plan.status, .blocked)
        XCTAssertNil(plan.executionTurnId)
        XCTAssertNil(plan.pauseReason)
        XCTAssertEqual(plan.steps.map(\.status), [.completed, .blocked])
        XCTAssertEqual(plan.currentStep?.id, "step-2")
        XCTAssertEqual(plan.currentStepIndex, 1)
        XCTAssertEqual(plan.steps[1].lastBlocker, "Needs the auth decision")
        // The backend bounds text in UTF-16 code units, as JavaScript counts.
        XCTAssertEqual(plan.objective, "Ship the 🚀 importer")
        XCTAssertEqual(plan.objective.utf16.count, 20)
        XCTAssertEqual(plan.steps[0].outcome?.utf16.count, 29)
    }

    func testEncodeRoundTripKeepsThePlan() throws {
        let response = try decode(Self.planReadFixture)
        let reencoded = try JSONDecoder().decode(AgentSessionPlanResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(reencoded, response)
    }

    func testDecodesAbsentPlan() throws {
        let response = try decode(#"{"schemaVersion":1,"plan":null}"#)
        XCTAssertNil(response.plan)
    }

    func testUnknownStatusesDecodeThroughTheirRawValue() throws {
        let fixture = Self.planReadFixture
            .replacingOccurrences(of: #""status":"blocked","createdAt""#, with: #""status":"archived","createdAt""#)
            .replacingOccurrences(of: #""status":"completed""#, with: #""status":"superseded""#)
            .replacingOccurrences(of: #""pauseReason":null"#, with: #""pauseReason":"operator_paused""#)
        let plan = try XCTUnwrap(try decode(fixture).plan)
        XCTAssertEqual(plan.status.rawValue, "archived")
        XCTAssertFalse(plan.status.isTerminal)
        XCTAssertEqual(plan.steps[0].status.rawValue, "superseded")
        XCTAssertFalse(plan.steps[0].status.isResolved)
        XCTAssertEqual(plan.pauseReason?.rawValue, "operator_paused")
    }

    func testTurnContextCarriesPlanToolsRequiredOnlyWhenSet() throws {
        XCTAssertNil(AgentTurnContext.forTurn(paths: [], attachments: [], planToolsRequired: false))
        let required = try XCTUnwrap(AgentTurnContext.forTurn(paths: [], attachments: [], planToolsRequired: true))
        XCTAssertEqual(try jsonObject(required), ["planToolsRequired": true])
        let paths = try XCTUnwrap(AgentTurnContext.forTurn(paths: ["README.md"], attachments: [], planToolsRequired: false))
        XCTAssertEqual(try jsonObject(paths), ["paths": ["README.md"]])
    }

    func testPlanReadUsesAuthenticatedSessionRoute() async throws {
        PlanURLProtocol.respond(status: 200, body: #"{"schemaVersion":1,"plan":null}"#)
        let response = try await makeClient().fetchAgentSessionPlan(sessionId: "agent-session-1")
        let request = try XCTUnwrap(PlanURLProtocol.request)
        XCTAssertEqual(request.url?.path, "/base/api/agent-sessions/agent-session-1/plan")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertNil(response.plan)
    }

    func testSendTurnPostsPlanToolsRequired() async throws {
        PlanURLProtocol.respond(status: 200, body: "{}")
        _ = try? await makeClient().sendAgentTurn(sessionId: "agent-session-1", message: "Plan it", planToolsRequired: true)
        let body = try XCTUnwrap(PlanURLProtocol.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["context"] as? [String: Bool], ["planToolsRequired": true])
    }

    func testOlderBackendRouteMissIsUnsupportedNotAnAbsentPlan() async throws {
        // Fastify's default body for a route an older backend never registered.
        PlanURLProtocol.respond(status: 404, body: """
        {"message":"Route GET:/api/agent-sessions/agent-session-1/plan not found","error":"Not Found","statusCode":404}
        """)
        await assertPlanReadThrows(.unsupportedBackend)
    }

    func testUnknownSessionIsNotAnUnsupportedBackend() async throws {
        PlanURLProtocol.respond(status: 404, body: #"{"error":"Agent session was not found"}"#)
        await assertPlanReadThrows(.sessionNotFound("Agent session was not found"))
    }

    func testUnresolvedPlanWriteIsUnavailable() async throws {
        PlanURLProtocol.respond(status: 503, body: #"{"error":"This thread's plan state is being recovered; retry shortly"}"#)
        await assertPlanReadThrows(.unavailable("This thread's plan state is being recovered; retry shortly"))
    }

    func testRejectedTokenStaysUnauthorized() async throws {
        PlanURLProtocol.respond(status: 401, body: #"{"error":"Unauthorized"}"#)
        do {
            _ = try await makeClient().fetchAgentSessionPlan(sessionId: "agent-session-1")
            XCTFail("A 401 must throw")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .unauthorized)
        }
    }

    // BEGIN PLAN CHANGED EVENT FIXTURE
    private static let planChangedEventFixture = """
    {"id":"event-1","type":"agent_plan_changed","at":"2026-09-28T01:05:00.000Z","payload":{"schemaVersion":1,"sessionId":"agent-session-abc123","planId":"plan-5b0c1f5e-0d6e-4c43-9a55-1f0e8f7a3c21","revision":8}}
    """
    // END PLAN CHANGED EVENT FIXTURE

    func testDecodesPlanChangedEvent() throws {
        let event = try JSONDecoder().decode(AgentRoomEvent.self, from: Data(Self.planChangedEventFixture.utf8))
        let change = try XCTUnwrap(AgentPlanChangedEvent(event: event))
        XCTAssertEqual(change, AgentPlanChangedEvent(
            schemaVersion: 1,
            sessionId: "agent-session-abc123",
            planId: "plan-5b0c1f5e-0d6e-4c43-9a55-1f0e8f7a3c21",
            revision: 8
        ))
        XCTAssertEqual(event.sessionId, "agent-session-abc123")
    }

    func testPlanChangedEventRejectsOtherTypesAndPartialPayloads() {
        let payload: JSONValue = .object([
            "schemaVersion": .number(1), "sessionId": .string("s"), "planId": .string("p"), "revision": .number(2)
        ])
        XCTAssertNil(AgentPlanChangedEvent(event: AgentRoomEvent(id: "e", type: "coding_plan_updated", at: "t", payload: payload)))
        let partial: JSONValue = .object(["schemaVersion": .number(1), "sessionId": .string("s"), "planId": .string("p")])
        XCTAssertNil(AgentPlanChangedEvent(event: AgentRoomEvent(id: "e", type: "agent_plan_changed", at: "t", payload: partial)))
        XCTAssertNotNil(AgentPlanChangedEvent(event: AgentRoomEvent(id: "e", type: "agent_plan_changed", at: "t", payload: payload)))
    }

    private func assertPlanReadThrows(
        _ expected: AgentSessionPlanReadError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            _ = try await makeClient().fetchAgentSessionPlan(sessionId: "agent-session-1")
            XCTFail("Expected \(expected), got a plan read", file: file, line: line)
        } catch let error as AgentSessionPlanReadError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("Expected \(expected), got \(error)", file: file, line: line)
        }
    }

    private func decode(_ json: String) throws -> AgentSessionPlanResponse {
        try JSONDecoder().decode(AgentSessionPlanResponse.self, from: Data(json.utf8))
    }

    private func jsonObject(_ context: AgentTurnContext) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(context)) as? NSDictionary)
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PlanURLProtocol.self]
        return APIClient(serverBaseURL: URL(string: "http://example.test/base")!, authToken: "test-token",
                         urlSession: URLSession(configuration: config))
    }
}

private final class PlanURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var request: URLRequest?
    nonisolated(unsafe) static var body: Data?
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var responseBody = Data()

    static func respond(status: Int, body: String) {
        request = nil
        self.body = nil
        self.status = status
        responseBody = Data(body.utf8)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        Self.body = request.httpBody ?? request.httpBodyStream.map(Self.readAll)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    private static func readAll(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
