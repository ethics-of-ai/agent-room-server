import Foundation

/// One answered set: the chosen option ids and the person's free text where the
/// set invited it. On `coding_question_resolved` a sensitive set's text is absent.
public struct CodingQuestionAnswer: Codable, Hashable, Sendable {
    public var setId: String
    public var selectedOptionIds: [String]
    public var discussion: String?

    public init(setId: String, selectedOptionIds: [String], discussion: String? = nil) {
        self.setId = setId
        self.selectedOptionIds = selectedOptionIds
        self.discussion = discussion
    }
}
