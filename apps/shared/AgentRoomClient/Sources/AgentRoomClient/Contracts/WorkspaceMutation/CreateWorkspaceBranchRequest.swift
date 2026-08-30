import Foundation

public struct CreateWorkspaceBranchRequest: Codable, Hashable {
    public var branch: String

    public init(branch: String) {
        self.branch = branch
    }
}
