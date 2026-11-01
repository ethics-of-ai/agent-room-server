import Foundation

/// A child's latest turn as its summary reports it.
public struct ChildThreadLastTurn: Codable, Hashable, Sendable {
    public var turnId: String
    /// `running`, `succeeded`, `failed` or `cancelled`.
    public var status: String
    /// The turn's last message or error, secret-redacted and capped at 2,000
    /// characters.
    public var lastMessage: String?

    public init(turnId: String, status: String, lastMessage: String? = nil) {
        self.turnId = turnId
        self.status = status
        self.lastMessage = lastMessage
    }
}
