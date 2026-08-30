import Foundation

public struct LocalWorkspaceRegistrySnapshot: Codable, Hashable {
    public var defaultWorkspaceRoot: String
    public var workspaces: [LocalWorkspace]

    public init(defaultWorkspaceRoot: String, workspaces: [LocalWorkspace]) {
        self.defaultWorkspaceRoot = defaultWorkspaceRoot
        self.workspaces = workspaces
    }
}
