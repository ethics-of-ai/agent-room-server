import Foundation

public struct WorkspaceBranchSwitchResponse: Codable, Hashable {
    public var workspace: LocalWorkspace
    public var previousBranch: String?
    public var branch: String
    public var changed: Bool

    public init(
        workspace: LocalWorkspace,
        previousBranch: String? = nil,
        branch: String,
        changed: Bool
    ) {
        self.workspace = workspace
        self.previousBranch = previousBranch
        self.branch = branch
        self.changed = changed
    }
}
