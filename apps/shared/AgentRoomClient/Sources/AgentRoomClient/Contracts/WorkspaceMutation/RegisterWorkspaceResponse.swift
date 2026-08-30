import Foundation

public struct RegisterWorkspaceResponse: Codable, Hashable {
    public var workspace: LocalWorkspace

    public init(workspace: LocalWorkspace) {
        self.workspace = workspace
    }
}
