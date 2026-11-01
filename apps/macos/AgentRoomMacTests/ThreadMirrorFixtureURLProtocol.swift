import Foundation
@testable import AgentRoomMac

final class ThreadMirrorFixtureURLProtocol: URLProtocol {
    static func apiClient(scenario: String) -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ThreadMirrorFixtureURLProtocol.self]
        guard let url = URL(string: "http://\(scenario).invalid") else { preconditionFailure("Invalid fixture URL") }
        return APIClient(serverBaseURL: url, authToken: "",
                         urlSession: URLSession(configuration: config))
    }

    /// A parent with an open and a closed child, an unrelated thread, and a
    /// child whose parent session is gone, in no particular order.
    private static let familySessions = """
    {"sessions":[\
    {"id":"parent","workspaceId":"w","workspacePath":"/tmp/repo","runnerKind":"codex","title":"Parent","status":"idle",\
    "turnCount":1,"createdAt":"2026-10-31T10:00:00Z","updatedAt":"2026-10-31T10:00:00Z"},\
    {"id":"orphan","workspaceId":"w-orphan","workspacePath":"/tmp/wt/orphan","runnerKind":"codex","title":"Orphan","status":"idle",\
    "turnCount":1,"createdAt":"2026-10-31T08:00:00Z","updatedAt":"2026-10-31T08:00:00Z",\
    "parent":{"sessionId":"deleted-parent","workspaceId":"w"},"closedAt":"2026-10-31T08:30:00Z"},\
    {"id":"child-open","workspaceId":"w-open","workspacePath":"/tmp/wt/open","runnerKind":"codex","title":"Open child",\
    "status":"running","activeTurnId":"t1","turnCount":1,"createdAt":"2026-10-31T11:00:00Z","updatedAt":"2026-10-31T12:00:00Z",\
    "parent":{"sessionId":"parent","workspaceId":"w"}},\
    {"id":"other","workspaceId":"w","workspacePath":"/tmp/repo","runnerKind":"claude_code","title":"Other","status":"idle",\
    "turnCount":2,"createdAt":"2026-10-31T11:00:00Z","updatedAt":"2026-10-31T11:00:00Z"},\
    {"id":"child-closed","workspaceId":"w-closed","workspacePath":"/tmp/wt/closed","gitBranch":"agentroom/closed-1a2b3c4d",\
    "runnerKind":"codex","title":"Closed child","status":"idle","turnCount":1,"createdAt":"2026-10-31T09:00:00Z",\
    "updatedAt":"2026-10-31T09:00:00Z","parent":{"sessionId":"parent","workspaceId":"w"},"closedAt":"2026-10-31T09:30:00Z"}\
    ]}
    """

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let failed = url.host == "failure.invalid"
        let body: String
        switch url.path {
        case "/api/status":
            body = #"{"runnerKind":"codex","uptimeSeconds":0,"sessions":[],"activeSessionIds":[],"recentEvents":[],"metrics":{"totalTokens":0,"totalSessions":1,"runningSessions":0,"completedTurns":0,"failedTurns":0,"cancelledTurns":0,"inputTokens":0,"outputTokens":0}}"#
        case "/api/agent-sessions":
            switch url.host {
            case "removed.invalid": body = #"{"sessions":[]}"#
            case "family.invalid": body = Self.familySessions
            default: body = #"{"sessions":[{"id":"one","workspaceId":"w","workspacePath":"/tmp/fixture","runnerKind":"codex","title":"Fixture","status":"idle","turnCount":0,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}]}"#
            }
        default:
            body = #"{"messages":[]}"#
        }
        guard let response = HTTPURLResponse(url: url, statusCode: failed ? 500 : 200,
                                             httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((failed ? #"{"error":"fixture refresh failed"}"# : body).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
