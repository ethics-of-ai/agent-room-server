import Foundation

public struct AgentTurnContext: Codable, Hashable {
    public var paths: [String]?
    public var attachments: [String]?
    /// Fail the turn unless the runner confirms its plan tools registered.
    /// Requires readiness only: it neither executes a plan nor changes
    /// permissions. A backend answers `409` before the turn starts when the
    /// session's runner does not support plan tools.
    public var planToolsRequired: Bool?

    public init(
        paths: [String]? = nil,
        attachments: [String]? = nil,
        planToolsRequired: Bool? = nil
    ) {
        self.paths = paths
        self.attachments = attachments
        self.planToolsRequired = planToolsRequired
    }

    /// The context a turn request carries, or nil when it would be empty, so
    /// an ordinary turn sends no `context` object at all.
    public static func forTurn(paths: [String], attachments: [String], planToolsRequired: Bool) -> AgentTurnContext? {
        guard !paths.isEmpty || !attachments.isEmpty || planToolsRequired else { return nil }
        return AgentTurnContext(paths: paths.isEmpty ? nil : paths, attachments: attachments.isEmpty ? nil : attachments,
                                planToolsRequired: planToolsRequired ? true : nil)
    }
}
