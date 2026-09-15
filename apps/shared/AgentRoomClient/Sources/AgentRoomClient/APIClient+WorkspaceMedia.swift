import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public extension APIClient {
    func downloadWorkspaceMedia(
        workspaceId: String,
        path: String,
        kind: WorkspaceMediaKind
    ) async throws -> WorkspaceMediaDownload {
        let endpoint = try url(
            pathSegments: ["api", "workspaces", workspaceId, "file-media"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        let transfer = WorkspaceMediaTransfer(kind: kind, path: path)
        return try await transfer.download(request: request, configuration: urlSession.configuration)
    }
}
