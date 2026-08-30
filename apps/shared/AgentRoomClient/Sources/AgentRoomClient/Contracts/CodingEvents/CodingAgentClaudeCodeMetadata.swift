import Foundation

public struct CodingAgentClaudeCodeMetadata: Codable, Hashable, Sendable {
    public var sessionId: String?
    public var messageUuid: String?
    public var parentToolUseId: String?
    public var model: String?
    public var cwd: String?
    public var permissionMode: String?

    public init(
        sessionId: String? = nil,
        messageUuid: String? = nil,
        parentToolUseId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        permissionMode: String? = nil
    ) {
        self.sessionId = sessionId
        self.messageUuid = messageUuid
        self.parentToolUseId = parentToolUseId
        self.model = model
        self.cwd = cwd
        self.permissionMode = permissionMode
    }
}
