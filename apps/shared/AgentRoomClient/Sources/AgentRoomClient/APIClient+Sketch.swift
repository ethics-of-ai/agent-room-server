import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The endpoint seam for one repository sketch file. `SessionSketchModel` owns
/// the client behavior and speaks to the backend only through this protocol,
/// so state tests inject a fake and `RepositorySketchSender` is the shipping
/// implementor. Every call addresses one workspace-relative path.
public protocol SketchSending {
    func fetchSketch() async throws -> SessionSketchReadResponse
    func commitSketch(_ request: SketchCommitRequest) async throws -> SketchTransactionOutcome
    func undoSketch(_ request: SketchUndoRedoRequest) async throws -> SketchTransactionOutcome
    func redoSketch(_ request: SketchUndoRedoRequest) async throws -> SketchTransactionOutcome
    func resetSketchHistory(fileVersion: String) async throws -> SessionSketchReadResponse
}

extension APIClient {
    // MARK: - Plumbing

    /// Same URL, bearer, and JSON conventions as the generic request path,
    /// kept here because `APIClient.swift` sits at its recorded size ceiling
    /// and the sketch routes need the error body's `code`/`currentRevision`
    /// before the generic path would surface them. URL construction still
    /// goes through the shared helper, so endpoint spelling stays single-source.
    func sketchRequest<T: Decodable>(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        queryItems: [URLQueryItem] = []
    ) async throws -> T {
        try await sketchRequestData(pathSegments, method: method, body: body, queryItems: queryItems) { data in
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw APIClientError.invalidResponse("Backend response did not match the expected shape.")
            }
        }
    }

    private func sketchRequestData<T>(
        _ pathSegments: [String],
        method: String,
        body: Data?,
        queryItems: [URLQueryItem],
        decode: (Data) throws -> T
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
            throw sketchError(statusCode: http.statusCode, body: data)
        }
        return try decode(data)
    }

    private func sketchError(statusCode: Int, body: Data) -> SketchEndpointError {
        struct ErrorBody: Decodable {
            var error: String?
            var code: String?
            var currentRevision: Int?
        }
        let decoded = try? JSONDecoder().decode(ErrorBody.self, from: body)
        if statusCode == 401 {
            // Keep the shared unauthorized meaning for expired or wrong tokens.
            return SketchEndpointError(
                statusCode: statusCode,
                code: nil,
                message: APIClientError.unauthorized.errorDescription ?? "Unauthorized",
                currentRevision: nil
            )
        }
        return SketchEndpointError(
            statusCode: statusCode,
            code: decoded?.code,
            message: decoded?.error ?? "Backend returned HTTP \(statusCode).",
            currentRevision: decoded?.currentRevision
        )
    }
}
