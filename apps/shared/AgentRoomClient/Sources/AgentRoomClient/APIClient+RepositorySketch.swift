import Foundation

extension APIClient {
    /// Creates an empty sketch named from `name`. The backend picks the path:
    /// `docs/sketches/` when that directory exists, and the first free
    /// `-2`…`-5` suffix when the name is taken.
    public func createRepositorySketch(workspaceId: String, name: String) async throws -> SessionSketchCreateResponse {
        try await sketchRequest(
            ["api", "workspaces", workspaceId, "sketch"],
            method: "POST", body: JSONEncoder().encode(["name": name])
        )
    }
}
