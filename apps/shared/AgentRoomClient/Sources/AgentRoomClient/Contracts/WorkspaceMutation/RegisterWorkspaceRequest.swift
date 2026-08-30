import Foundation

public struct RegisterWorkspaceRequest: Codable, Hashable {
    public var path: String
    public var kind: String

    public init(path: String, kind: String = "user_selected") {
        self.path = path
        self.kind = kind
    }
}
