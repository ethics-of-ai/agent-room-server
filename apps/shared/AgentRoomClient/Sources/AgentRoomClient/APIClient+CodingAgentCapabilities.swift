import Foundation

extension APIClient {
    /// `refresh` asks the backend to skip its cached discovery, for when the
    /// operator has just changed something the cache would hide.
    public func fetchCodingAgentCapabilities(
        runnerKind: String? = nil,
        refresh: Bool = false
    ) async throws -> CodingAgentCapabilitiesResponse {
        var queryItems = runnerKind.map { [URLQueryItem(name: "runnerKind", value: $0)] } ?? []
        if refresh { queryItems.append(URLQueryItem(name: "refresh", value: "true")) }
        return try await request(["api", "coding-agent", "capabilities"], queryItems: queryItems)
    }
}
