import Foundation

/// The skills a runner kind would natively load from a registered workspace.
/// `available` is `false` when sessions of that kind would not load them (the
/// Claude Code workspace-settings gate); the list is empty in that state.
public struct WorkspaceSkillsSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var runnerKind: String
    public var available: Bool
    public var skills: [WorkspaceSkill]

    public init(workspaceId: String, runnerKind: String, available: Bool, skills: [WorkspaceSkill]) {
        self.workspaceId = workspaceId
        self.runnerKind = runnerKind
        self.available = available
        self.skills = skills
    }
}
