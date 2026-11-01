import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension APIClient {
    /// Same URL, bearer and JSON conventions as the generic request path, for
    /// the routes whose refusals carry a `code` the generic path would fold
    /// into a plain message: the sketch and child-thread routes. It lives here
    /// because `APIClient.swift` sits at its recorded size ceiling. `refusal`
    /// turns a non-2xx status and its body, when that decodes, into the error
    /// thrown.
    func codedRefusalRequest<T: Decodable>(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        queryItems: [URLQueryItem] = [],
        refusal: (_ statusCode: Int, _ body: CodedRefusalBody?) -> Error
    ) async throws -> T {
        var request = URLRequest(url: try url(pathSegments: pathSegments, queryItems: queryItems))
        request.httpMethod = method
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw refusal(http.statusCode, try? JSONDecoder().decode(CodedRefusalBody.self, from: data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIClientError.invalidResponse("Backend response did not match the expected shape.")
        }
    }
}
