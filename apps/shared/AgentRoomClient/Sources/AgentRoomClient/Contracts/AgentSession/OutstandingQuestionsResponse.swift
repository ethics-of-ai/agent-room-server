import Foundation

public struct OutstandingQuestionsResponse: Codable, Hashable {
    public var questions: [OutstandingQuestionRequest]

    public init(questions: [OutstandingQuestionRequest]) {
        self.questions = questions
    }
}
