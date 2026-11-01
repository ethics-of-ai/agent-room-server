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

    /// The sketch routes' requests. Their refusals keep `code` and
    /// `currentRevision`, which the generic path would not surface.
    func sketchRequest<T: Decodable>(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        queryItems: [URLQueryItem] = []
    ) async throws -> T {
        try await codedRefusalRequest(pathSegments, method: method, body: body, queryItems: queryItems) { statusCode, body in
            Self.sketchError(statusCode: statusCode, body: body)
        }
    }

    private static func sketchError(statusCode: Int, body decoded: CodedRefusalBody?) -> SketchEndpointError {
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
