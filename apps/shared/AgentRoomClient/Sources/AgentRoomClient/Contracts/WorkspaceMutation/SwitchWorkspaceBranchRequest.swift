import Foundation

public struct SwitchWorkspaceBranchRequest: Codable, Hashable {
    public var branch: String

    public init(branch: String) {
        self.branch = branch
    }
}
