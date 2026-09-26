import Foundation

/// A sketch selection recorded in a historical transcript. This metadata
/// grants no tool authority and is not part of new turn requests.
public struct AgentTurnSketchContext: Codable, Hashable, Sendable {
    public var sketchId: String
    public var revision: Int
    public var objectIds: [String]

    public init(sketchId: String, revision: Int, objectIds: [String]) {
        self.sketchId = sketchId
        self.revision = revision
        self.objectIds = objectIds
    }
}
