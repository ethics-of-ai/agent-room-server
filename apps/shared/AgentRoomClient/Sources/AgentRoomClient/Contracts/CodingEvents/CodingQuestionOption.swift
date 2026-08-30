import Foundation

/// One option the agent offered for a clarifying-question set. A client answers
/// with these `optionId`s and nothing else: the backend minted them and refuses
/// one the agent did not offer for that set.
public struct CodingQuestionOption: Codable, Hashable, Identifiable, Sendable {
    public var optionId: String
    public var label: String
    public var description: String?

    public var id: String { optionId }

    public init(optionId: String, label: String, description: String? = nil) {
        self.optionId = optionId
        self.label = label
        self.description = description
    }
}
