import Foundation

extension APIClient {
    /// Run one `tools/call` from an MCP tool view on the server its artifact
    /// came from, and return the tool's `CallToolResult`. The backend picks the
    /// server; the view names only the tool. `404` means the server lists no
    /// such tool for apps, and `409` that no running agent can make the call.
    public func callToolAppTool(
        sessionId: String,
        artifactId: String,
        name: String,
        arguments: [String: JSONValue]
    ) async throws -> [String: JSONValue] {
        let body = try JSONEncoder().encode(ToolAppCallRequest(name: name, arguments: arguments))
        let response: ToolAppCallResponse = try await request(
            ["api", "agent-sessions", sessionId, "artifacts", artifactId, "tool-calls"],
            method: "POST",
            body: body
        )
        return response.result
    }
}

private struct ToolAppCallRequest: Encodable {
    let name: String
    let arguments: [String: JSONValue]
}

private struct ToolAppCallResponse: Decodable {
    let result: [String: JSONValue]
}
