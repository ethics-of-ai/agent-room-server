import XCTest
@testable import AgentRoomClient
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class AgentRoomReleaseClientTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        ReleaseURLProtocol.reset()
        suiteName = "AgentRoomReleaseClientTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        ReleaseURLProtocol.reset()
        defaults = nil
        suiteName = nil
    }

    func testDiscoversValidatedReleaseAndUsesFreshCache() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(
                    request: request,
                    status: 200,
                    headers: ["ETag": "\"release-1\""],
                    body: Self.githubReleaseJSON
                )
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)
        let checkedAt = Date(timeIntervalSince1970: 1_800_000_000)

        let firstLookup = try await client.latestRelease(now: checkedAt)
        let secondLookup = try await client.latestRelease(now: checkedAt.addingTimeInterval(60))
        let first = firstLookup.release

        XCTAssertEqual(first.manifest.backendVersion, "1.2.3")
        XCTAssertEqual(first.macDownloadURL.absoluteString, "https://downloads.example/AgentRoom-1.2.3-arm64.dmg")
        XCTAssertEqual(
            first.releasePageURL.absoluteString,
            "https://github.com/ethics-of-ai/agent-room-server/releases/tag/v1.2.3"
        )
        XCTAssertNotEqual(first.macDownloadURL, first.releasePageURL)
        XCTAssertEqual(firstLookup.source, .network)
        XCTAssertEqual(secondLookup.release, first)
        XCTAssertEqual(secondLookup.source, .freshCache)
        XCTAssertEqual(ReleaseURLProtocol.recordedRequests.count, 2)
        let releaseRequest = try XCTUnwrap(ReleaseURLProtocol.recordedRequests.first)
        XCTAssertEqual(releaseRequest.value(forHTTPHeaderField: "Accept"), "application/vnd.github+json")
        XCTAssertEqual(releaseRequest.value(forHTTPHeaderField: "X-GitHub-Api-Version"), "2022-11-28")
        XCTAssertNil(releaseRequest.value(forHTTPHeaderField: "Authorization"))
    }

    func testConditionalRefreshUsesETagAndReusesValidatedRelease() async throws {
        let session = makeSession()
        var latestRequestCount = 0
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                latestRequestCount += 1
                if latestRequestCount == 2 {
                    return Self.response(request: request, status: 304)
                }
                return Self.response(
                    request: request,
                    status: 200,
                    headers: ["ETag": "\"release-1\""],
                    body: Self.githubReleaseJSON
                )
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        _ = try await client.latestRelease(now: Date(timeIntervalSince1970: 1_800_000_000))
        let refreshed = try await client.latestRelease(
            forceRefresh: true,
            now: Date(timeIntervalSince1970: 1_800_100_000)
        )

        XCTAssertEqual(refreshed.release.checkedAt, Date(timeIntervalSince1970: 1_800_100_000))
        XCTAssertEqual(refreshed.source, .network)
        XCTAssertEqual(ReleaseURLProtocol.recordedRequests.count, 3)
        let conditionalRequest = try XCTUnwrap(ReleaseURLProtocol.recordedRequests.last)
        XCTAssertEqual(conditionalRequest.value(forHTTPHeaderField: "If-None-Match"), "\"release-1\"")
    }

    func testRejectsManifestThatNamesTheWrongMacArtifact() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            let invalid = Self.manifestJSON.replacingOccurrences(
                of: "AgentRoom-1.2.3-arm64.dmg",
                with: "AgentRoom-1.2.3-x86_64.dmg"
            )
            return Self.response(request: request, status: 200, body: invalid)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        do {
            _ = try await client.latestRelease()
            XCTFail("Expected the mismatched artifact to be rejected")
        } catch let error as AgentRoomReleaseError {
            XCTAssertEqual(error, .macArtifactInvalid)
        }
    }

    func testFallsBackToValidatedCacheWhenGitHubIsUnavailable() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)
        let original = try await client.latestRelease(now: Date(timeIntervalSince1970: 1_800_000_000))
        ReleaseURLProtocol.install { request in
            Self.response(request: request, status: 503)
        }

        let fallback = try await client.latestRelease(
            forceRefresh: true,
            now: Date(timeIntervalSince1970: 1_800_100_000)
        )

        XCTAssertEqual(fallback.release, original.release)
        XCTAssertEqual(fallback.source, .staleCache)
    }

    func testReportsRateLimitWhenNoValidatedCacheExists() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            Self.response(request: request, status: 403)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        do {
            _ = try await client.latestRelease()
            XCTFail("Expected the rate-limited lookup to fail")
        } catch let error as AgentRoomReleaseError {
            XCTAssertEqual(error, .githubRequestFailed(statusCode: 403))
        }
    }

    func testRejectsReleaseWithoutItsVersionedManifest() async throws {
        let session = makeSession()
        let withoutManifest = Self.githubReleaseJSON.replacingOccurrences(
            of: "AgentRoom-1.2.3-release.json",
            with: "unrelated.json"
        )
        ReleaseURLProtocol.install { request in
            Self.response(request: request, status: 200, body: withoutManifest)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        do {
            _ = try await client.latestRelease()
            XCTFail("Expected the missing manifest to be rejected")
        } catch let error as AgentRoomReleaseError {
            XCTAssertEqual(error, .manifestMissing("AgentRoom-1.2.3-release.json"))
        }
    }

    func testRejectsMalformedManifestJSON() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            return Self.response(request: request, status: 200, body: "{not-json")
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        do {
            _ = try await client.latestRelease()
            XCTFail("Expected malformed manifest JSON to be rejected")
        } catch let error as AgentRoomReleaseError {
            XCTAssertEqual(error, .invalidManifest)
        }
    }

    func testConcurrentLookupsShareOneNetworkRequest() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        async let first = client.latestRelease(forceRefresh: true)
        async let second = client.latestRelease(forceRefresh: true)
        let lookups = try await [first, second]

        XCTAssertEqual(lookups.map(\.release), [lookups[0].release, lookups[0].release])
        XCTAssertEqual(ReleaseURLProtocol.recordedRequests.count, 2)
    }

    func testConcurrentFailedRefreshesBothReceiveTheStaleCacheWarning() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)
        _ = try await client.latestRelease()
        ReleaseURLProtocol.install { request in
            Self.response(request: request, status: 503)
        }

        async let first = client.latestRelease(forceRefresh: true)
        async let second = client.latestRelease(forceRefresh: true)
        let lookups = try await [first, second]

        XCTAssertEqual(lookups.map(\.source), [.staleCache, .staleCache])
        XCTAssertEqual(ReleaseURLProtocol.recordedRequests.count, 3)
    }

    func testRejectsPrereleaseCatalogResponse() async throws {
        let session = makeSession()
        let prerelease = Self.githubReleaseJSON.replacingOccurrences(
            of: "\"prerelease\": false",
            with: "\"prerelease\": true"
        )
        ReleaseURLProtocol.install { request in
            Self.response(request: request, status: 200, body: prerelease)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        await assertReleaseError(.draftOrPrerelease) {
            _ = try await client.latestRelease()
        }
    }

    func testRejectsUnsupportedManifestSchema() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            let unsupported = Self.manifestJSON.replacingOccurrences(
                of: "\"schemaVersion\": 1",
                with: "\"schemaVersion\": 2"
            )
            return Self.response(request: request, status: 200, body: unsupported)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        await assertReleaseError(.unsupportedManifestSchema(2)) {
            _ = try await client.latestRelease()
        }
    }

    func testRejectsManifestVersionMismatch() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            let mismatched = Self.manifestJSON.replacingOccurrences(
                of: "\"backendVersion\": \"1.2.3\"",
                with: "\"backendVersion\": \"9.9.9\""
            )
            return Self.response(request: request, status: 200, body: mismatched)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        await assertReleaseError(.manifestVersionMismatch) {
            _ = try await client.latestRelease()
        }
    }

    func testRejectsReleaseWithoutDeclaredDMG() async throws {
        let session = makeSession()
        let withoutDMG = Self.githubReleaseJSON.replacingOccurrences(
            of: "AgentRoom-1.2.3-arm64.dmg",
            with: "unrelated.dmg"
        )
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: withoutDMG)
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)

        await assertReleaseError(.macArtifactMissing("AgentRoom-1.2.3-arm64.dmg")) {
            _ = try await client.latestRelease()
        }
    }

    func testLatestReleaseCanRequireANewerBackend() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            return Self.response(request: request, status: 200, body: Self.manifestJSON)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)
        let lookup = try await client.latestRelease()
        let currentClient = AgentRoomClientCompatibility(
            platform: .visionos,
            clientVersion: "1.0.0",
            clientBuild: "1",
            clientAPIVersion: "2026-05-12",
            minimumSupportedBackendAPIVersion: "2099-01-01"
        )

        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: lookup.release.manifest.compatibility,
                client: currentClient
            ),
            .backendUpdateRequired
        )
    }

    func testLatestReleaseCanRequireANewerVisionOSClient() async throws {
        let session = makeSession()
        ReleaseURLProtocol.install { request in
            if request.url?.path.hasSuffix("/releases/latest") == true {
                return Self.response(request: request, status: 200, body: Self.githubReleaseJSON)
            }
            let newerClient = Self.manifestJSON.replacingOccurrences(
                of: "\"minimumVersion\": \"0.1.0\"",
                with: "\"minimumVersion\": \"99.0.0\""
            )
            return Self.response(request: request, status: 200, body: newerClient)
        }
        let client = AgentRoomReleaseClient(urlSession: session, cacheSuiteName: suiteName)
        let lookup = try await client.latestRelease()
        let currentClient = AgentRoomClientCompatibility(
            platform: .visionos,
            clientVersion: "1.0.0",
            clientBuild: "1",
            clientAPIVersion: "2026-05-12",
            minimumSupportedBackendAPIVersion: "2026-05-12"
        )

        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: lookup.release.manifest.compatibility,
                client: currentClient
            ),
            .clientUpdateRequired
        )
    }

    private func assertReleaseError(
        _ expected: AgentRoomReleaseError,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("Expected release lookup to fail with \(expected)")
        } catch let error as AgentRoomReleaseError {
            XCTAssertEqual(error, expected)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReleaseURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func response(
        request: URLRequest,
        status: Int,
        headers: [String: String]? = nil,
        body: String = ""
    ) -> (HTTPURLResponse, Data) {
        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: nil,
                headerFields: headers
              ) else {
            fatalError("The test request must contain a valid URL")
        }
        return (response, Data(body.utf8))
    }

    private static let githubReleaseJSON = """
    {
      "tag_name": "v1.2.3",
      "html_url": "https://github.com/ethics-of-ai/agent-room-server/releases/tag/v1.2.3",
      "published_at": "2026-08-26T08:00:00Z",
      "draft": false,
      "prerelease": false,
      "ignored_future_field": true,
      "assets": [
        {
          "name": "AgentRoom-1.2.3-release.json",
          "browser_download_url": "https://downloads.example/AgentRoom-1.2.3-release.json",
          "size": 400
        },
        {
          "name": "AgentRoom-1.2.3-arm64.dmg",
          "browser_download_url": "https://downloads.example/AgentRoom-1.2.3-arm64.dmg",
          "size": 12000000
        }
      ]
    }
    """

    private static let manifestJSON = """
    {
      "schemaVersion": 1,
      "backendVersion": "1.2.3",
      "apiVersion": "2026-05-12",
      "minimumSupportedClientApiVersion": "2026-05-12",
      "compatibleClients": {
        "visionos": { "minimumVersion": "0.1.0" },
        "macos": { "minimumVersion": "0.1.0" }
      },
      "macArtifact": {
        "name": "AgentRoom-1.2.3-arm64.dmg",
        "architecture": "arm64"
      },
      "ignoredFutureField": "allowed"
    }
    """
}

private final class ReleaseURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) -> (HTTPURLResponse, Data)

    private static let state = ReleaseURLProtocolState()

    static var recordedRequests: [URLRequest] {
        state.recordedRequests
    }

    static func install(_ handler: @escaping Handler) {
        state.install(handler)
    }

    static func reset() {
        state.reset()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.state.record(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ReleaseURLProtocolState: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ReleaseURLProtocol.Handler?
    private var requests: [URLRequest] = []

    var recordedRequests: [URLRequest] {
        lock.withLock { requests }
    }

    func install(_ handler: @escaping ReleaseURLProtocol.Handler) {
        lock.withLock { self.handler = handler }
    }

    func reset() {
        lock.withLock {
            handler = nil
            requests = []
        }
    }

    func record(_ request: URLRequest) -> ReleaseURLProtocol.Handler? {
        lock.withLock {
            requests.append(request)
            return handler
        }
    }
}
