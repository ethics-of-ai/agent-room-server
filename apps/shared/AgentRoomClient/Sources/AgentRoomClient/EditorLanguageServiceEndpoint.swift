import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Builds the safe language-service catalog read and the authenticated workspace socket request.
/// Keeping this beside the language-service contracts avoids growing the recorded `APIClient.swift`.
public struct EditorLanguageServiceEndpoint {
    public static let protocolVersion = 1

    public var serverBaseURL: URL
    public var authToken: String
    private var urlSession: URLSession

    public init(serverBaseURL: URL, authToken: String, urlSession: URLSession = .shared) {
        self.serverBaseURL = serverBaseURL
        self.authToken = authToken
        self.urlSession = urlSession
    }

    public init(client: APIClient, urlSession: URLSession? = nil) {
        self.init(
            serverBaseURL: client.serverBaseURL,
            authToken: client.authToken,
            urlSession: urlSession ?? client.urlSession
        )
    }

    public func fetchCatalog() async throws -> LanguageServiceCatalog {
        var request = URLRequest(url: try url(pathSegments: ["api", "editor", "language-services"]))
        authorize(&request)
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIClientError.unauthorized }
            throw APIClientError.server("Backend returned HTTP \(http.statusCode).")
        }
        do {
            return try JSONDecoder().decode(LanguageServiceCatalog.self, from: data)
        } catch {
            throw APIClientError.invalidResponse("Language-service catalog did not match protocol version 1.")
        }
    }

    public func socketRequest(workspaceId: String) throws -> URLRequest {
        guard var components = URLComponents(
            url: try url(pathSegments: ["api", "workspaces", workspaceId, "editor", "language-service"]),
            resolvingAgainstBaseURL: false
        ) else { throw URLError(.badURL) }
        let secure = components.scheme == "https"
        components.scheme = secure ? "wss" : "ws"
        guard let socketURL = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: socketURL)
        authorize(&request)
        return request
    }

    private func authorize(_ request: inout URLRequest) {
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
    }

    private func url(pathSegments: [String]) throws -> URL {
        try APIClient(serverBaseURL: serverBaseURL, authToken: authToken).url(pathSegments: pathSegments)
    }
}
