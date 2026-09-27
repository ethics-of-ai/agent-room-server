import Foundation
import XCTest
@testable import AgentRoomClient

final class CodingAgentCapabilitiesClientTests: XCTestCase {
    func testAPlainReadLeavesTheBackendCacheAlone() async throws {
        let components = try await capabilitiesRequest { try await $0.fetchCodingAgentCapabilities(runnerKind: "claude_code") }
        XCTAssertEqual(components.path, "/base/api/coding-agent/capabilities")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "runnerKind", value: "claude_code")])
    }

    func testARefreshAsksTheBackendToSkipItsCache() async throws {
        let components = try await capabilitiesRequest {
            try await $0.fetchCodingAgentCapabilities(runnerKind: "claude_code", refresh: true)
        }
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "runnerKind", value: "claude_code"),
            URLQueryItem(name: "refresh", value: "true")
        ])
    }

    private func capabilitiesRequest(
        _ fetch: (APIClient) async throws -> CodingAgentCapabilitiesResponse
    ) async throws -> URLComponents {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CapabilitiesURLProtocol.self]
        let client = APIClient(serverBaseURL: URL(string: "http://example.test/base")!, authToken: "test-token",
                               urlSession: URLSession(configuration: config))
        _ = try await fetch(client)
        let request = try XCTUnwrap(CapabilitiesURLProtocol.request)
        return try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
    }
}

private final class CapabilitiesURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var request: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        let body = Data(#"{"runnerKind":"claude_code","settings":{"models":[],"defaultSettings":{}}}"#.utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
