import Foundation

/// One clarifying-question batch a session still holds open, as served by
/// `GET /api/agent-sessions/:id/questions` for a client that joined after the
/// event replay rolled over. The sets are exactly what the request event carried.
public struct OutstandingQuestionRequest: Codable, Hashable, Identifiable {
    public var requestId: String
    public var turnId: String
    public var questionSets: [CodingQuestionSet]

    public var id: String { requestId }

    public init(requestId: String, turnId: String, questionSets: [CodingQuestionSet]) {
        self.requestId = requestId
        self.turnId = turnId
        self.questionSets = questionSets
    }
}
