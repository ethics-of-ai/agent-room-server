import Foundation

public struct AgentSessionMessageContext: Codable, Hashable {
    public var paths: [String]?
    public var attachments: [AgentSessionMessageContextAttachment]?
    /// Set on the user message the backend records when a person answers a
    /// clarifying-question batch: the batch it answers. A client can caption
    /// that message as the answer it is rather than as a typed turn.
    public var questionRequestId: String?

    public init(
        paths: [String]? = nil,
        attachments: [AgentSessionMessageContextAttachment]? = nil,
        questionRequestId: String? = nil
    ) {
        self.paths = paths
        self.attachments = attachments
        self.questionRequestId = questionRequestId
    }
}
