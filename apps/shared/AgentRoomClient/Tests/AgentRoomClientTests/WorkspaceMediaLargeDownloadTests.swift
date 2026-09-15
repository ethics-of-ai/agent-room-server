import Foundation
import XCTest
@testable import AgentRoomClient

final class WorkspaceMediaLargeDownloadTests: XCTestCase {
    func testDownloadsUSDZAboveFormerCapWithAndWithoutContentLength() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LargeMediaURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test")),
            authToken: "secret",
            urlSession: session
        )
        for path in ["declared.usdz", "unknown.usdz"] {
            let download = try await client.downloadWorkspaceMedia(
                workspaceId: "workspace", path: path, kind: .usdz
            )
            defer { try? FileManager.default.removeItem(at: download.fileURL) }
            XCTAssertEqual(download.byteCount, Int64(LargeMediaURLProtocol.byteCount))
            let handle = try FileHandle(forReadingFrom: download.fileURL)
            defer { try? handle.close() }
            XCTAssertEqual(try handle.read(upToCount: 4), Data([0x50, 0x4b, 3, 4]))
            try handle.seek(toOffset: UInt64(LargeMediaURLProtocol.byteCount - 1))
            XCTAssertEqual(try handle.read(upToCount: 1), Data([42]))
        }
    }
}

private final class LargeMediaURLProtocol: URLProtocol {
    static let byteCount = 50 * 1_024 * 1_024 + 1

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        var headers = ["Content-Type": "model/vnd.usdz+zip"]
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "path" })?.value
        if path == "declared.usdz" { headers["Content-Length"] = String(Self.byteCount) }
        guard let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: nil, headerFields: headers
        ) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var body = Data(count: Self.byteCount)
        body.replaceSubrange(0..<4, with: [0x50, 0x4b, 3, 4])
        body[Self.byteCount - 1] = 42
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
