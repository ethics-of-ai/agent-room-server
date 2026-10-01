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
            body = url.host == "removed.invalid" ? #"{"sessions":[]}"# : #"{"sessions":[{"id":"one","workspaceId":"w","workspacePath":"/tmp/fixture","runnerKind":"codex","title":"Fixture","status":"idle","turnCount":0,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}]}"#
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
