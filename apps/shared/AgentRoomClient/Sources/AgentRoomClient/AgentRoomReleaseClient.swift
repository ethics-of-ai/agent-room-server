import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Discovers the latest public AgentRoom for Mac release without credentials.
///
/// Results are advisory. Connection compatibility is always evaluated from
/// the backend's own `/health.release` response.
public actor AgentRoomReleaseClient {
    public static let defaultRepository = "ethics-of-ai/agent-room-server"
    private static let githubAPIBaseURLString = "https://api.github.com"

    private let urlSession: URLSession
    private let userDefaults: UserDefaults
    private let repository: String
    private let cacheLifetime: TimeInterval
    private var inFlightRequest: Task<FetchResult, Error>?

    public init(
        urlSession: URLSession = .shared,
        cacheSuiteName: String? = nil,
        repository: String = AgentRoomReleaseClient.defaultRepository,
        cacheLifetime: TimeInterval = 24 * 60 * 60
    ) {
        self.urlSession = urlSession
        self.userDefaults = cacheSuiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
        self.repository = repository
        self.cacheLifetime = cacheLifetime
    }

    public func latestRelease(
        forceRefresh: Bool = false,
        now: Date = .now
    ) async throws -> AgentRoomReleaseLookup {
        let cached = loadCache()
        if !forceRefresh,
           let cached,
           now.timeIntervalSince(cached.release.checkedAt) < cacheLifetime {
            return AgentRoomReleaseLookup(release: cached.release, source: .freshCache)
        }

        if let inFlightRequest {
            do {
                return AgentRoomReleaseLookup(
                    release: try await inFlightRequest.value.release,
                    source: .network
                )
            } catch {
                if let cached {
                    return AgentRoomReleaseLookup(release: cached.release, source: .staleCache)
                }
                throw error
            }
        }

        let request = Task {
            try await Self.fetchLatestRelease(
                urlSession: urlSession,
                repository: repository,
                cached: cached,
                now: now
            )
        }
        inFlightRequest = request
        defer { inFlightRequest = nil }

        do {
            let result = try await request.value
            saveCache(result.cache)
            return AgentRoomReleaseLookup(release: result.release, source: .network)
        } catch {
            // Release discovery must remain useful during a transient GitHub or
            // network failure. A stale, previously validated release is safer
            // than inventing a URL or hiding all download guidance.
            if let cached {
                return AgentRoomReleaseLookup(release: cached.release, source: .staleCache)
            }
            throw error
        }
    }

    private var cacheKey: String {
        let identity = repository.replacing("/", with: ".")
        return "AgentRoomReleaseClient.\(identity).v1"
    }

    private func loadCache() -> Cache? {
        guard let data = userDefaults.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(Cache.self, from: data)
    }

    private func saveCache(_ cache: Cache) {
        guard let data = try? JSONEncoder().encode(cache) else { return }
        userDefaults.set(data, forKey: cacheKey)
    }

    private static func fetchLatestRelease(
        urlSession: URLSession,
        repository: String,
        cached: Cache?,
        now: Date
    ) async throws -> FetchResult {
        guard let githubAPIBaseURL = URL(string: githubAPIBaseURLString) else {
            throw AgentRoomReleaseError.invalidGitHubResponse
        }
        let releaseURL = githubAPIBaseURL
            .appending(path: "repos")
            .appending(path: repository)
            .appending(path: "releases")
            .appending(path: "latest")
        var request = URLRequest(url: releaseURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("AgentRoom-visionOS", forHTTPHeaderField: "User-Agent")
        if let etag = cached?.etag {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AgentRoomReleaseError.invalidGitHubResponse
        }
        if http.statusCode == 304, let cached {
            var release = cached.release
            release.checkedAt = now
            let refreshed = Cache(release: release, etag: cached.etag)
            return FetchResult(release: release, cache: refreshed)
        }
        guard http.statusCode == 200 else {
            throw AgentRoomReleaseError.githubRequestFailed(statusCode: http.statusCode)
        }

        let githubRelease: GitHubRelease
        do {
            githubRelease = try JSONDecoder().decode(GitHubRelease.self, from: data)
        } catch {
            throw AgentRoomReleaseError.invalidGitHubResponse
        }
        guard !githubRelease.draft, !githubRelease.prerelease else {
            throw AgentRoomReleaseError.draftOrPrerelease
        }
        guard githubRelease.tagName.hasPrefix("v"),
              SemanticVersion(rawValue: String(githubRelease.tagName.dropFirst())) != nil else {
            throw AgentRoomReleaseError.invalidReleaseTag
        }

        let version = String(githubRelease.tagName.dropFirst())
        let manifestName = "AgentRoom-\(version)-release.json"
        guard let manifestAsset = githubRelease.assets.first(where: { $0.name == manifestName }) else {
            throw AgentRoomReleaseError.manifestMissing(manifestName)
        }
        let (manifestData, manifestResponse) = try await urlSession.data(from: manifestAsset.browserDownloadURL)
        guard let manifestHTTP = manifestResponse as? HTTPURLResponse,
              manifestHTTP.statusCode == 200 else {
            throw AgentRoomReleaseError.invalidManifest
        }

        let manifest: AgentRoomReleaseManifest
        do {
            manifest = try JSONDecoder().decode(AgentRoomReleaseManifest.self, from: manifestData)
        } catch {
            throw AgentRoomReleaseError.invalidManifest
        }
        guard manifest.schemaVersion == 1 else {
            throw AgentRoomReleaseError.unsupportedManifestSchema(manifest.schemaVersion)
        }
        guard manifest.backendVersion == version else {
            throw AgentRoomReleaseError.manifestVersionMismatch
        }
        guard manifest.macArtifact.architecture == "arm64",
              manifest.macArtifact.name == "AgentRoom-\(version)-arm64.dmg" else {
            throw AgentRoomReleaseError.macArtifactInvalid
        }
        guard let macAsset = githubRelease.assets.first(where: { $0.name == manifest.macArtifact.name }) else {
            throw AgentRoomReleaseError.macArtifactMissing(manifest.macArtifact.name)
        }

        let release = AgentRoomRelease(
            tagName: githubRelease.tagName,
            releasePageURL: githubRelease.htmlURL,
            publishedAt: githubRelease.publishedAt.flatMap(parseGitHubDate),
            manifest: manifest,
            macDownloadURL: macAsset.browserDownloadURL,
            macAssetSizeBytes: macAsset.size,
            checkedAt: now
        )
        let cache = Cache(
            release: release,
            etag: http.value(forHTTPHeaderField: "ETag")
        )
        return FetchResult(release: release, cache: cache)
    }

    private static func parseGitHubDate(_ value: String) -> Date? {
        ISO8601DateFormatter().date(from: value)
    }
}

private extension AgentRoomReleaseClient {
    struct GitHubRelease: Decodable, Sendable {
        var tagName: String
        var htmlURL: URL
        var publishedAt: String?
        var draft: Bool
        var prerelease: Bool
        var assets: [GitHubAsset]

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
            case publishedAt = "published_at"
            case draft
            case prerelease
            case assets
        }
    }

    struct GitHubAsset: Decodable, Sendable {
        var name: String
        var browserDownloadURL: URL
        var size: Int?

        enum CodingKeys: String, CodingKey {
            case name
            case browserDownloadURL = "browser_download_url"
            case size
        }
    }

    struct Cache: Codable, Sendable {
        var release: AgentRoomRelease
        var etag: String?
    }

    struct FetchResult: Sendable {
        var release: AgentRoomRelease
        var cache: Cache
    }
}
