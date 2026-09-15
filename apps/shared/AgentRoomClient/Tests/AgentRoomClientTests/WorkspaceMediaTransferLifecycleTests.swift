import Foundation
import XCTest
@testable import AgentRoomClient

final class WorkspaceMediaTransferLifecycleTests: XCTestCase {
    func testCancellationRemovesPartiallyWrittenDownload() async throws {
        let directory = mediaDirectory
        let before = ownedFiles()
        let task = Task {
            let client = try Self.makeClient()
            return try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "cancel.usdz", kind: .usdz)
        }
        defer { task.cancel() }
        var observedPartialFile = false
        for _ in 0..<200 {
            for name in ownedFiles().subtracting(before) {
                let attributes = try FileManager.default.attributesOfItem(atPath: directory.appending(path: name).path)
                if (attributes[.size] as? NSNumber)?.intValue == 128 * 1_024 { observedPartialFile = true }
            }
            if observedPartialFile { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(observedPartialFile, "The cancellation must happen after a real chunk reaches disk")
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertEqual(ownedFiles(), before)
    }

    func testTransportFailureRemovesPartiallyWrittenDownload() async throws {
        let client = try Self.makeClient()
        let before = ownedFiles()
        do {
            _ = try await client.downloadWorkspaceMedia(workspaceId: "ws", path: "fail.usdz", kind: .usdz)
            XCTFail("Expected transport failure")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        XCTAssertEqual(ownedFiles(), before)
    }

    private var mediaDirectory: URL {
        FileManager.default.temporaryDirectory.appending(path: "AgentRoomWorkspaceMedia")
    }

    private func ownedFiles() -> Set<String> {
        (try? Set(FileManager.default.contentsOfDirectory(atPath: mediaDirectory.path))) ?? []
    }

    private static func makeClient() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PartialMediaURLProtocol.self]
        return APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://media.test")),
            authToken: "token",
            urlSession: URLSession(configuration: configuration)
        )
    }
}

private final class PartialMediaURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                  headerFields: ["Content-Type": "model/vnd.usdz+zip"])
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let chunk = Data(repeating: 42, count: 64 * 1_024)
        client?.urlProtocol(self, didLoad: chunk)
        client?.urlProtocol(self, didLoad: chunk)
        if url.query?.contains("fail.usdz") == true {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        }
    }

    override func stopLoading() {}
}
