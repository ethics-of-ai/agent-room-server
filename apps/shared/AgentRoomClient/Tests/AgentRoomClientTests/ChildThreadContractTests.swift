import Foundation
import XCTest
@testable import AgentRoomClient

final class ChildThreadContractTests: XCTestCase {
    private static let summaryJSON = """
    {"sessionId":"agent-session-child456","title":"Add a --json flag","runnerKind":"codex","status":"idle",\
    "workspaceId":"workspace-0f1e2d3c4b5a","branch":"agentroom/add-a-json-flag-3f9a1c2e",\
    "baseCommit":"4b825dc642cb6eb9a060e54bf8d69288fbee4904","commitsAhead":1,"uncommitted":true,"untrackedCount":0,\
    "missing":false,"continuable":true,"diff":{"files":3,"insertions":42,"deletions":7},\
    "lastTurn":{"turnId":"agent-turn-789","status":"succeeded","lastMessage":"Added the flag and a test."},\
    "updatedAt":"2026-10-31T10:00:00.000Z"}
    """

    private static let closedSummaryJSON = """
    {"sessionId":"agent-session-child457","title":"Old child","runnerKind":"claude_code","status":"idle",\
    "closedAt":"2026-10-31T11:00:00.000Z","workspaceId":"workspace-gone","branch":"","baseCommit":"",\
    "commitsAhead":0,"uncommitted":false,"untrackedCount":0,"missing":true,"continuable":false,\
    "diff":{"files":0,"insertions":0,"deletions":0},"lastTurn":{"turnId":"agent-turn-1","status":"failed"},\
    "updatedAt":"2026-10-31T11:00:00.000Z"}
    """

    private static func workspaceJSON(extra: String = "") -> String {
        """
        {"id":"workspace-0f1e2d3c4b5a","name":"Add a --json flag","path":"/tmp/wt/add-a-json-flag-3f9a1c2e",\
        "kind":"managed_worktree","trustedAt":"2026-10-31T10:00:00.000Z","lastOpenedAt":"2026-10-31T10:00:00.000Z",\
        "git":{"isRepository":true,"branch":"agentroom/add-a-json-flag-3f9a1c2e","remote":null}\(extra)}
        """
    }

    private static let worktreeJSON = """
    ,"worktree":{"parentWorkspaceId":"workspace-abc123def456","worktreePath":"/tmp/wt/add-a-json-flag-3f9a1c2e",\
    "branch":"agentroom/add-a-json-flag-3f9a1c2e","baseCommit":"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}
    """

    private static func sessionJSON(extra: String = "") -> String {
        """
        {"id":"agent-session-child456","workspaceId":"workspace-0f1e2d3c4b5a",\
        "workspacePath":"/tmp/wt/add-a-json-flag-3f9a1c2e","runnerKind":"codex","title":"Add a --json flag",\
        "status":"running","activeTurnId":"agent-turn-789","lastMessage":null,"error":null,"turnCount":1,\
        "createdAt":"2026-10-31T10:00:00.000Z","updatedAt":"2026-10-31T10:00:00.000Z"\(extra)}
        """
    }

    private static let gitResultJSON = """
    {"workspaceId":"workspace-abc123def456","operation":"merge_ff","workspace":\(workspaceJSON()),\
    "status":{"workspaceId":"workspace-abc123def456","isRepository":true,"branch":"main","clean":true,\
    "counts":{"total":0,"staged":0,"unstaged":0,"untracked":0,"conflicts":0},"files":[],"truncated":false,\
    "refreshedAt":"2026-10-31T10:05:00.000Z"},"branch":"agentroom/add-a-json-flag-3f9a1c2e",\
    "commit":"9fceb02d0ae598e95dc970b74767f19372d61af8"}
    """

    // MARK: - Turn triggers

    func testOldShapeBackgroundTaskTriggerStillDecodes() throws {
        let trigger = try decode(AgentTurnTrigger.self, """
        {"kind":"background_task","tasks":[{"id":"task-1","description":"Review","status":"completed"}]}
        """)
        XCTAssertEqual(trigger.kind, "background_task")
        XCTAssertEqual(trigger.tasks.map(\.id), ["task-1"])
        XCTAssertNil(trigger.parentSessionId)
        XCTAssertNil(trigger.reports)
    }

    func testParentTaskTriggerDecodes() throws {
        let trigger = try decode(AgentTurnTrigger.self, """
        {"kind":"parent_task","parentSessionId":"agent-session-parent123","tasks":[]}
        """)
        XCTAssertEqual(trigger.kind, "parent_task")
        XCTAssertEqual(trigger.parentSessionId, "agent-session-parent123")
        XCTAssertEqual(trigger.tasks, [])
        XCTAssertNil(trigger.reports)
    }

    func testChildReportTriggerDecodesOnATurn() throws {
        let turn = try decode(AgentSessionTurn.self, """
        {"id":"agent-turn-wake","sessionId":"agent-session-parent123","status":"running",\
        "startedAt":"2026-10-31T10:10:00.000Z","completedAt":null,"lastMessage":null,"error":null,\
        "inputTokens":0,"outputTokens":0,"totalTokens":0,"trigger":{"kind":"child_report","reports":[\
        {"childSessionId":"agent-session-child456","turnId":"agent-turn-789","status":"succeeded"},\
        {"childSessionId":"agent-session-child457","turnId":"agent-turn-790","status":"cancelled"}],"tasks":[]}}
        """)
        let trigger = try XCTUnwrap(turn.trigger)
        XCTAssertEqual(trigger.kind, "child_report")
        XCTAssertEqual(trigger.reports, [
            AgentTurnChildReport(childSessionId: "agent-session-child456", turnId: "agent-turn-789", status: "succeeded"),
            AgentTurnChildReport(childSessionId: "agent-session-child457", turnId: "agent-turn-790", status: "cancelled")
        ])
        XCTAssertNil(trigger.parentSessionId)
    }

    func testSystemMessageDecodesItsOriginAndOtherMessagesHaveNone() throws {
        let opening = try decode(AgentSessionMessage.self, """
        {"id":"message-1","sessionId":"agent-session-child456","turnId":"agent-turn-789","role":"system",\
        "content":"Task from your parent thread:","origin":"parent_task","status":"sent","at":"2026-10-31T10:00:00.000Z"}
        """)
        XCTAssertEqual(opening.origin, "parent_task")

        let person = try decode(AgentSessionMessage.self, """
        {"id":"message-2","sessionId":"agent-session-child456","turnId":"agent-turn-790","role":"user",\
        "content":"More.","status":"sent","at":"2026-10-31T10:05:00.000Z"}
        """)
        XCTAssertNil(person.origin)
        XCTAssertEqual(AgentSessionMessageOrigin(message: opening), .parentTask)
        XCTAssertEqual(AgentSessionMessageOrigin(message: opening)?.label, "Task from parent thread")
        XCTAssertNil(AgentSessionMessageOrigin(message: person))
    }

    func testRunnerDescriptorDecodesWhetherItCanRunAChild() throws {
        let catalog = try decode(RunnerCatalogResponse.self, """
        {"runners":[{"runnerKind":"codex","displayName":"Codex","registered":true,"childThreads":true},\
        {"runnerKind":"acp_demo","displayName":"ACP Demo","registered":true,"childThreads":false},\
        {"runnerKind":"older","displayName":"Older"}]}
        """)
        XCTAssertEqual(catalog.runners.map(\.childThreads), [true, false, nil])
    }

    func testOnlyAManagedWorktreeIsAChildWorktree() throws {
        XCTAssertTrue(try decode(LocalWorkspace.self, Self.workspaceJSON()).isChildWorktree)
        let selected = Self.workspaceJSON().replacing("managed_worktree", with: "user_selected")
        XCTAssertFalse(try decode(LocalWorkspace.self, selected).isChildWorktree)
    }

    // MARK: - Sessions and workspaces

    func testSessionWithoutChildFieldsDecodes() throws {
        let session = try decode(AgentSession.self, Self.sessionJSON())
        XCTAssertNil(session.parent)
        XCTAssertNil(session.closedAt)
    }

    func testChildSessionDecodesParentAndClosedAt() throws {
        let session = try decode(AgentSession.self, Self.sessionJSON(extra: """
        ,"parent":{"sessionId":"agent-session-parent123","workspaceId":"workspace-abc123def456","operationId":"call-1"},\
        "closedAt":"2026-10-31T11:00:00.000Z"
        """))
        XCTAssertEqual(session.parent, AgentSessionParent(
            sessionId: "agent-session-parent123",
            workspaceId: "workspace-abc123def456",
            operationId: "call-1"
        ))
        XCTAssertEqual(session.closedAt, "2026-10-31T11:00:00.000Z")

        let withoutOperation = try decode(AgentSession.self, Self.sessionJSON(extra: """
        ,"parent":{"sessionId":"agent-session-parent123","workspaceId":"workspace-abc123def456"}
        """))
        XCTAssertNil(withoutOperation.parent?.operationId)
    }

    func testWorkspaceWithoutWorktreeDecodes() throws {
        let workspace = try decode(LocalWorkspace.self, Self.workspaceJSON())
        XCTAssertEqual(workspace.kind, "managed_worktree")
        XCTAssertNil(workspace.worktree)
    }

    func testWorkspaceDecodesWorktree() throws {
        let workspace = try decode(LocalWorkspace.self, Self.workspaceJSON(extra: Self.worktreeJSON))
        XCTAssertEqual(workspace.worktree, LocalWorkspaceWorktree(
            parentWorkspaceId: "workspace-abc123def456",
            worktreePath: "/tmp/wt/add-a-json-flag-3f9a1c2e",
            branch: "agentroom/add-a-json-flag-3f9a1c2e",
            baseCommit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        ))
    }

    // MARK: - Summaries and responses

    func testSummaryDecodes() throws {
        let summary = try decode(ChildThreadSummary.self, Self.summaryJSON)
        XCTAssertEqual(summary.id, "agent-session-child456")
        XCTAssertEqual(summary.status, "idle")
        XCTAssertNil(summary.activeTurnId)
        XCTAssertNil(summary.closedAt)
        XCTAssertEqual(summary.commitsAhead, 1)
        XCTAssertTrue(summary.uncommitted)
        XCTAssertFalse(summary.missing)
        XCTAssertTrue(summary.continuable)
        XCTAssertEqual(summary.diff, ChildThreadDiffStat(files: 3, insertions: 42, deletions: 7))
        XCTAssertNil(summary.waitingOn)
        XCTAssertEqual(summary.lastTurn?.lastMessage, "Added the flag and a test.")
    }

    func testClosedSummaryDecodesWithEmptyBranchAndNoLastMessage() throws {
        let summary = try decode(ChildThreadSummary.self, Self.closedSummaryJSON)
        XCTAssertEqual(summary.closedAt, "2026-10-31T11:00:00.000Z")
        XCTAssertTrue(summary.missing)
        XCTAssertFalse(summary.continuable)
        XCTAssertEqual(summary.branch, "")
        XCTAssertEqual(summary.baseCommit, "")
        XCTAssertEqual(summary.lastTurn?.status, "failed")
        XCTAssertNil(summary.lastTurn?.lastMessage)
    }

    func testWaitingSummaryCarriesWaitingOn() throws {
        let json = Self.summaryJSON.replacing(#""status":"idle","#, with: #""status":"running","activeTurnId":"agent-turn-790","waitingOn":"permission","#)
        let summary = try decode(ChildThreadSummary.self, json)
        XCTAssertEqual(summary.activeTurnId, "agent-turn-790")
        XCTAssertEqual(summary.waitingOn, "permission")
    }

    func testListDecodesWaitingReportsAndToleratesTheirAbsence() throws {
        let current = try decode(ChildThreadListResponse.self, #"{"children":[],"parentToolsAvailable":true,"waitingReports":2}"#)
        XCTAssertEqual(current.waitingReports, 2)
        let older = try decode(ChildThreadListResponse.self, #"{"children":[],"parentToolsAvailable":false}"#)
        XCTAssertNil(older.waitingReports)
    }

    func testLandResponseDecodesTheNewGitOperation() throws {
        let response = try decode(ChildThreadGitResponse.self, #"{"git":\#(Self.gitResultJSON),"child":\#(Self.summaryJSON)}"#)
        XCTAssertEqual(response.git.operation, .mergeFastForward)
        XCTAssertEqual(response.git.commit, "9fceb02d0ae598e95dc970b74767f19372d61af8")
        XCTAssertEqual(response.child.sessionId, "agent-session-child456")
    }

    func testChildGitOperationNamesRoundTrip() throws {
        let names = ["worktree_add", "worktree_remove", "branch_delete", "merge_ff", "update_from_parent"]
        let operations = try names.map { try decode(WorkspaceGitOperation.self, #""\#($0)""#) }
        XCTAssertEqual(operations, [.worktreeAdd, .worktreeRemove, .branchDelete, .mergeFastForward, .updateFromParent])
        XCTAssertEqual(operations.map(\.rawValue), names)
    }

    // MARK: - Events

    func testDecodesChildChangedEvent() throws {
        let event = try decode(AgentRoomEvent.self, """
        {"id":"event-1","type":"agent_child_changed","at":"2026-10-31T10:00:00.000Z","payload":{\
        "parentSessionId":"agent-session-parent123","childSessionId":"agent-session-child456","change":"created",\
        "initiation":"button","audit":{"parentSessionId":"agent-session-parent123",\
        "childSessionId":"agent-session-child456","change":"created","initiation":"button"}}}
        """)
        XCTAssertNil(event.codingPayload)
        XCTAssertEqual(AgentChildChangedEvent(event: event), AgentChildChangedEvent(
            parentSessionId: "agent-session-parent123",
            childSessionId: "agent-session-child456",
            change: "created",
            initiation: "button"
        ))
    }

    func testChildChangedEventRejectsOtherTypesAndPartialPayloads() {
        let landed: JSONValue = .object([
            "parentSessionId": .string("p"), "childSessionId": .string("c"), "change": .string("landed")
        ])
        let event = AgentRoomEvent(id: "e", type: "agent_child_changed", at: "t", payload: landed)
        XCTAssertNil(AgentChildChangedEvent(event: event)?.initiation)
        XCTAssertEqual(AgentChildChangedEvent(event: event)?.change, "landed")
        XCTAssertNil(AgentChildChangedEvent(event: AgentRoomEvent(id: "e", type: "agent_plan_changed", at: "t", payload: landed)))
        let partial: JSONValue = .object(["parentSessionId": .string("p"), "change": .string("closed")])
        XCTAssertNil(AgentChildChangedEvent(event: AgentRoomEvent(id: "e", type: "agent_child_changed", at: "t", payload: partial)))
    }

    // MARK: - Requests

    func testCreateChildPostsToTheParentAndOmitsANilRunner() async throws {
        ChildURLProtocol.respond(status: 201, body: """
        {"session":\(Self.sessionJSON()),"workspace":\(Self.workspaceJSON(extra: Self.worktreeJSON))}
        """)
        let response = try await makeClient().createChildThread(
            parentSessionId: "agent-session-parent123",
            title: "Add a --json flag",
            task: "Add the flag"
        )
        let request = try XCTUnwrap(ChildURLProtocol.request)
        XCTAssertEqual(request.url?.path, "/base/api/agent-sessions/agent-session-parent123/children")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(ChildURLProtocol.body)) as? NSDictionary)
        XCTAssertEqual(body, ["title": "Add a --json flag", "task": "Add the flag"])
        XCTAssertEqual(response.session.id, "agent-session-child456")
        XCTAssertNotNil(response.workspace.worktree)
    }

    func testCreateChildSendsTheRunnerAndItsSettings() async throws {
        ChildURLProtocol.respond(status: 201, body: """
        {"session":\(Self.sessionJSON()),"workspace":\(Self.workspaceJSON(extra: Self.worktreeJSON))}
        """)
        _ = try await makeClient().createChildThread(
            parentSessionId: "agent-session-parent123",
            title: "Add a --json flag",
            task: "Add the flag",
            runnerKind: "claude_code",
            settings: CodingAgentTurnSettings(model: "claude-opus-5-5", reasoningEffort: "high")
        )
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(ChildURLProtocol.body)) as? NSDictionary)
        XCTAssertEqual(body, [
            "title": "Add a --json flag", "task": "Add the flag", "runnerKind": "claude_code",
            "settings": ["model": "claude-opus-5-5", "reasoningEffort": "high"]
        ])
    }

    func testListAsksForClosedChildrenOnlyWhenTold() async throws {
        ChildURLProtocol.respond(status: 200, body: #"{"children":[\#(Self.summaryJSON)],"parentToolsAvailable":false}"#)
        let open = try await makeClient().fetchChildThreads(parentSessionId: "agent-session-parent123")
        XCTAssertNil(ChildURLProtocol.request?.url?.query)
        XCTAssertEqual(open.children.map(\.sessionId), ["agent-session-child456"])
        XCTAssertFalse(open.parentToolsAvailable)

        ChildURLProtocol.respond(status: 200, body: #"{"children":[\#(Self.closedSummaryJSON)],"parentToolsAvailable":true}"#)
        let all = try await makeClient().fetchChildThreads(parentSessionId: "agent-session-parent123", includeClosed: true)
        XCTAssertEqual(ChildURLProtocol.request?.url?.query, "include=closed")
        XCTAssertEqual(ChildURLProtocol.request?.httpMethod, "GET")
        XCTAssertTrue(all.parentToolsAvailable)
    }

    func testLandUpdateAndCloseUseTheChildRoutes() async throws {
        let gitResponse = #"{"git":\#(Self.gitResultJSON),"child":\#(Self.summaryJSON)}"#
        ChildURLProtocol.respond(status: 200, body: gitResponse)
        _ = try await makeClient().landChildThread(sessionId: "agent-session-child456")
        XCTAssertEqual(ChildURLProtocol.request?.url?.path, "/base/api/agent-sessions/agent-session-child456/land")
        XCTAssertEqual(ChildURLProtocol.request?.httpMethod, "POST")

        ChildURLProtocol.respond(status: 200, body: gitResponse.replacing(#""merge_ff""#, with: #""update_from_parent""#))
        let updated = try await makeClient().updateChildThreadFromParent(sessionId: "agent-session-child456")
        XCTAssertEqual(ChildURLProtocol.request?.url?.path, "/base/api/agent-sessions/agent-session-child456/update-from-parent")
        XCTAssertEqual(updated.git.operation, .updateFromParent)

        ChildURLProtocol.respond(status: 200, body: #"{"branchKept":true}"#)
        let closed = try await makeClient().closeChildThread(sessionId: "agent-session-child456")
        XCTAssertEqual(ChildURLProtocol.request?.url?.path, "/base/api/agent-sessions/agent-session-child456/close")
        XCTAssertTrue(closed.branchKept)
    }

    // MARK: - Errors

    func testRefusalKeepsTheBackendCode() async throws {
        ChildURLProtocol.respond(status: 409, body: #"{"error":"The parent branch has moved; update from parent first","code":"not_fast_forward"}"#)
        let error = await childError { try await $0.landChildThread(sessionId: "agent-session-child456") }
        XCTAssertEqual(error, ChildThreadEndpointError(
            statusCode: 409,
            code: "not_fast_forward",
            message: "The parent branch has moved; update from parent first"
        ))
        XCTAssertTrue(error?.needsUpdateFromParent == true)
        XCTAssertFalse(error?.childHasUncommittedChanges == true)
        XCTAssertEqual(error?.localizedDescription, "The parent branch has moved; update from parent first")
    }

    func testDirtyChildRefusalAsksForChangeReview() async throws {
        ChildURLProtocol.respond(status: 409, body: #"{"error":"Commit the child's changes first","code":"child_dirty"}"#)
        let error = await childError { try await $0.closeChildThread(sessionId: "agent-session-child456") }
        XCTAssertEqual(error?.code, "child_dirty")
        XCTAssertTrue(error?.childHasUncommittedChanges == true)
    }

    func testOlderBackendRouteMissIsUnsupported() async throws {
        ChildURLProtocol.respond(status: 404, body: """
        {"message":"Route GET:/api/agent-sessions/agent-session-1/children not found","error":"Not Found","statusCode":404}
        """)
        let error = await childError { try await $0.fetchChildThreads(parentSessionId: "agent-session-1") }
        XCTAssertEqual(error?.isUnsupportedBackend, true)
        XCTAssertNil(error?.code)

        ChildURLProtocol.respond(status: 404, body: #"{"error":"Agent session was not found","code":"unknown_session"}"#)
        let unknown = await childError { try await $0.fetchChildThreads(parentSessionId: "agent-session-1") }
        XCTAssertEqual(unknown?.isUnsupportedBackend, false)
        XCTAssertEqual(unknown?.code, "unknown_session")
    }

    func testRejectedTokenStaysUnauthorized() async throws {
        ChildURLProtocol.respond(status: 401, body: #"{"error":"Unauthorized"}"#)
        do {
            _ = try await makeClient().fetchChildThreads(parentSessionId: "agent-session-1")
            XCTFail("A 401 must throw")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .unauthorized)
        }
    }

    // MARK: - Helpers

    private func childError<T>(_ call: (APIClient) async throws -> T) async -> ChildThreadEndpointError? {
        do {
            _ = try await call(makeClient())
            XCTFail("Expected a ChildThreadEndpointError")
            return nil
        } catch let error as ChildThreadEndpointError {
            return error
        } catch {
            XCTFail("Expected a ChildThreadEndpointError, got \(error)")
            return nil
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChildURLProtocol.self]
        return APIClient(serverBaseURL: URL(string: "http://example.test/base")!, authToken: "test-token",
                         urlSession: URLSession(configuration: config))
    }
}

private final class ChildURLProtocol: URLProtocol, @unchecked Sendable {
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
