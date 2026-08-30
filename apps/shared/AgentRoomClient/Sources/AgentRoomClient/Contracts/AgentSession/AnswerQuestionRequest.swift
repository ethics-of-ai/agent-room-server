import Foundation

/// Answers one outstanding clarifying-question batch: per answered set, the
/// option ids chosen from the ones the agent offered and the person's own free
/// text where the set invited it. A set the body omits stays unanswered. The
/// backend refuses a set or option the agent did not offer, a second choice on
/// a single-select set, and free text on a set that accepts none.
public struct AnswerQuestionRequest: Codable, Hashable {
    public var answers: [CodingQuestionAnswer]

    public init(answers: [CodingQuestionAnswer]) {
        self.answers = answers
    }
}
