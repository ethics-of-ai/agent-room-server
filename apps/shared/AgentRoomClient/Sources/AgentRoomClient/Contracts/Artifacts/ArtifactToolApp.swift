import Foundation

/// What an `mcp_app` artifact's view needs besides its HTML, which is the
/// artifact's `content`: the MCP tool behind it, its `ui://` resource's
/// `_meta.ui` (csp, permissions, prefersBorder), and the call's input and
/// `CallToolResult`. The client hands the view `tool`, the input and the
/// result. `supportsToolCalls` says the session's runner can run the view's
/// `tools/call` requests through `APIClient.callToolAppTool`.
public struct ArtifactToolApp: Codable, Hashable, Sendable {
    public var serverName: String
    public var toolName: String
    public var resourceUri: String
    /// The tool as an MCP `Tool`; the view gets it as `hostContext.toolInfo.tool`.
    public var tool: [String: JSONValue]
    public var resourceMeta: [String: JSONValue]?
    public var toolInput: [String: JSONValue]
    public var toolResult: [String: JSONValue]
    public var supportsToolCalls: Bool?

    public init(
        serverName: String,
        toolName: String,
        resourceUri: String,
        tool: [String: JSONValue],
        resourceMeta: [String: JSONValue]? = nil,
        toolInput: [String: JSONValue] = [:],
        toolResult: [String: JSONValue] = [:],
        supportsToolCalls: Bool? = nil
    ) {
        self.serverName = serverName
        self.toolName = toolName
        self.resourceUri = resourceUri
        self.tool = tool
        self.resourceMeta = resourceMeta
        self.toolInput = toolInput
        self.toolResult = toolResult
        self.supportsToolCalls = supportsToolCalls
    }
}
