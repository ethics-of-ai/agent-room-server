import Foundation

public struct AgentTurnContext: Codable, Hashable {
    public var paths: [String]?
    public var attachments: [String]?

    public init(paths: [String]? = nil, attachments: [String]? = nil) {
        self.paths = paths
        self.attachments = attachments
    }
}
