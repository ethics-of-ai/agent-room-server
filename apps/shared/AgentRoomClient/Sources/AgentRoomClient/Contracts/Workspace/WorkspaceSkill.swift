import Foundation

/// One user-invocable skill discovered in a registered workspace's committed
/// skill directories. `invocation` is the runner-appropriate composer token
/// (`/name` for Claude Code slash commands, `$name` for Codex skill mentions),
/// computed backend-side so clients never hardcode per-runner syntax.
public struct WorkspaceSkill: Codable, Hashable, Identifiable {
    public var name: String
    public var description: String?
    public var invocation: String
    public var source: String

    public var id: String { "\(source)/\(name)" }

    public init(name: String, description: String? = nil, invocation: String, source: String) {
        self.name = name
        self.description = description
        self.invocation = invocation
        self.source = source
    }
}
