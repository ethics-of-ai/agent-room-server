import Foundation
import XCTest
@testable import AgentRoomClient

final class GitHistoryClientTests: XCTestCase {
    func testHistoryUsesAuthenticatedReadWithEncodedRefQueries() async throws {
        let client = makeClient()
        GitHistoryURLProtocol.body = Data("""
        {"workspaceId":"workspace 1","isRepository":true,"refs":[],"refsTruncated":false,"commits":[],"truncated":true,"shallow":true,"refreshedAt":"now"}
        """.utf8)
        let history = try await client.fetchGitHistory(workspaceId: "workspace 1", branch: "refs/heads/feature#1", compare: "refs/remotes/origin/main", limit: 200)
        let request = try XCTUnwrap(GitHistoryURLProtocol.request)
        let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/base/api/workspaces/workspace 1/git/history")
        XCTAssertEqual(components.queryItems?.first { $0.name == "branch" }?.value, "refs/heads/feature#1")
        XCTAssertEqual(components.queryItems?.first { $0.name == "compare" }?.value, "refs/remotes/origin/main")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertTrue(history.truncated)
        XCTAssertTrue(history.shallow)
    }

    func testCommitDiffDecodesEmptySideAndEscapesLiteralPath() async throws {
        let client = makeClient()
        GitHistoryURLProtocol.body = Data("""
        {"workspaceId":"workspace 1","commit":"abc","path":"src/a&b.swift","before":"","after":"new"}
        """.utf8)
        let diff = try await client.fetchGitCommitDiff(workspaceId: "workspace 1", commit: "abc", path: "src/a&b.swift")
        let request = try XCTUnwrap(GitHistoryURLProtocol.request)
        let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first { $0.name == "path" }?.value, "src/a&b.swift")
        XCTAssertEqual(diff.before, "")
        XCTAssertNil(diff.parent)
        XCTAssertEqual(diff.after, "new")
    }

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GitHistoryURLProtocol.self]
        return APIClient(serverBaseURL: URL(string: "http://example.test/base")!, authToken: "test-token",
                         urlSession: URLSession(configuration: config))
    }
}

private final class GitHistoryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var request: URLRequest?
    nonisolated(unsafe) static var body = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
