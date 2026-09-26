import Foundation

public struct CodingAgentCapabilityCheck: Codable, Hashable, Identifiable {
    public var id: String
    public var status: String
    public var message: String

    public init(id: String, status: String, message: String) {
        self.id = id
        self.status = status
        self.message = message
    }
}
