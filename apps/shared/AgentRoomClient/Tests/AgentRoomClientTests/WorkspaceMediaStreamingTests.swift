import Foundation
import XCTest
@testable import AgentRoomClient

final class WorkspaceMediaStreamingTests: XCTestCase {
    func testRejectsOversizedDeclarationWithoutWaitingForCompleteBody() async throws {
        let client = try client(status: 200, headers: [
            "Content-Type": "image/png", "Content-Length": "20971521"
        ])
        BoundedMediaURLProtocol.body = Data(repeating: 65, count: 8 * 1_024)
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "image.png", kind: .image)
            XCTFail("Expected size refusal before the body arrives")
        } catch let error as WorkspaceMediaDownloadError {
            XCTAssertEqual(error, .tooLarge(limit: 20 * 1_024 * 1_024))
        }
    }

    func testErrorBodyStopsAtEightKiBEvenWhenServerDoesNotFinish() async throws {
        let client = try client(status: 404, headers: [:])
        BoundedMediaURLProtocol.body = Data(repeating: 65, count: 8 * 1_024)
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "image.png", kind: .image)
            XCTFail("Expected bounded HTTP error")
        } catch let error as WorkspaceMediaDownloadError {
            XCTAssertEqual(error, .server(statusCode: 404, code: nil, message: "Backend returned HTTP 404."))
        }
    }

    func testMissingLengthStopsAtCapPlusOneAndRemovesPartialFile() async throws {
        let client = try client(status: 200, headers: ["Content-Type": "image/png"])
        BoundedMediaURLProtocol.body = Data(repeating: 65, count: 20 * 1_024 * 1_024 + 1)
        let directory = FileManager.default.temporaryDirectory.appending(path: "AgentRoomWorkspaceMedia")
        let before = (try? Set(FileManager.default.contentsOfDirectory(atPath: directory.path))) ?? []
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "image.png", kind: .image)
            XCTFail("Expected cap refusal without waiting for EOF")
        } catch let error as WorkspaceMediaDownloadError {
            XCTAssertEqual(error, .tooLarge(limit: 20 * 1_024 * 1_024))
        }
        let after = (try? Set(FileManager.default.contentsOfDirectory(atPath: directory.path))) ?? []
        XCTAssertEqual(after, before)
    }

    func testBusyPreservesRetryAfterSecondsAndDate() async throws {
        let client = try client(status: 503, headers: ["Retry-After": "12"])
        BoundedMediaURLProtocol.finishes = true
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "image.png", kind: .image)
            XCTFail("Expected busy error")
        } catch let error as WorkspaceMediaDownloadError {
            XCTAssertEqual(error, .busy(retryAfter: 12))
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        BoundedMediaURLProtocol.headers = ["Retry-After": formatter.string(from: Date.now.addingTimeInterval(60))]
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "image.png", kind: .image)
            XCTFail("Expected busy error")
        } catch let error as WorkspaceMediaDownloadError {
            guard case .busy(let delay) = error else { return XCTFail("Expected retry delay") }
            XCTAssertGreaterThan(delay, 58)
            XCTAssertLessThanOrEqual(delay, 60)
        }
    }

    private func client(status: Int, headers: [String: String]) throws -> APIClient {
        BoundedMediaURLProtocol.status = status
        BoundedMediaURLProtocol.headers = headers
        BoundedMediaURLProtocol.body = Data()
        BoundedMediaURLProtocol.finishes = false
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.protocolClasses = [BoundedMediaURLProtocol.self]
        return APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://media.test")),
            authToken: "token",
            urlSession: URLSession(configuration: configuration)
        )
    }
}

private final class BoundedMediaURLProtocol: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var headers: [String: String] = [:]
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var finishes = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: Self.status, httpVersion: nil, headerFields: Self.headers)
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !Self.body.isEmpty { client?.urlProtocol(self, didLoad: Self.body) }
        if Self.finishes { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() {}
}
