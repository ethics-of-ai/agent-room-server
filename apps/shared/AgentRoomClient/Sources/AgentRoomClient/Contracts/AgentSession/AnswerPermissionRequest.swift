import Foundation

/// Answers one outstanding permission request. The body carries only an option
/// the agent itself offered; the request it belongs to is in the path, and the
/// backend refuses an option that was not among the ones it is holding.
public struct AnswerPermissionRequest: Codable, Hashable {
    public var optionId: String

    public init(optionId: String) {
        self.optionId = optionId
    }
}
