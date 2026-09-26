import Foundation

/// Sends one sketch file's reads and edits through the workspace sketch routes.
public struct RepositorySketchSender: SketchSending {
    public var client: APIClient
    public var workspaceId: String
    public var path: String

    public init(client: APIClient, workspaceId: String, path: String) {
        self.client = client
        self.workspaceId = workspaceId
        self.path = path
    }

    public func fetchSketch() async throws -> SessionSketchReadResponse {
        try await request()
    }

    public func commitSketch(_ request: SketchCommitRequest) async throws -> SketchTransactionOutcome {
        try await self.request("commits", body: JSONEncoder().encode(request))
    }

    public func undoSketch(_ request: SketchUndoRedoRequest) async throws -> SketchTransactionOutcome {
        try await self.request("undo", body: JSONEncoder().encode(request))
    }

    public func redoSketch(_ request: SketchUndoRedoRequest) async throws -> SketchTransactionOutcome {
        try await self.request("redo", body: JSONEncoder().encode(request))
    }

    public func resetSketchHistory(fileVersion: String) async throws -> SessionSketchReadResponse {
        try await request("reset-history", body: JSONEncoder().encode(["fileVersion": fileVersion]))
    }

    private func request<T: Decodable>(_ action: String? = nil, body: Data? = nil) async throws -> T {
        try await client.sketchRequest(
            ["api", "workspaces", workspaceId, "sketch"] + (action.map { [$0] } ?? []),
            method: action == nil ? "GET" : "POST", body: body,
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
    }
}
