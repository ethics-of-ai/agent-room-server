import Foundation

public struct WorkspaceGitCommitRequest: Codable, Hashable {
    public var message: String
    public var stageAll: Bool?

    public init(message: String, stageAll: Bool? = nil) {
        self.message = message
        self.stageAll = stageAll
    }
}
