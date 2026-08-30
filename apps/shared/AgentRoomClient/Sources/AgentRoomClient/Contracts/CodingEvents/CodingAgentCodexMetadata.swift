import Foundation

public struct CodingAgentCodexMetadata: Codable, Hashable, Sendable {
    public var method: String?
    public var threadId: String?
    public var turnId: String?
    public var itemId: String?
    public var model: String?
    public var cwd: String?
    public var approvalPolicy: String?
    public var sandbox: JSONValue?

    public init(
        method: String? = nil,
        threadId: String? = nil,
        turnId: String? = nil,
        itemId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        approvalPolicy: String? = nil,
        sandbox: JSONValue? = nil
    ) {
        self.method = method
        self.threadId = threadId
        self.turnId = turnId
        self.itemId = itemId
        self.model = model
        self.cwd = cwd
        self.approvalPolicy = approvalPolicy
        self.sandbox = sandbox
    }
}
