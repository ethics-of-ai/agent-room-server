import Foundation

/// One clarifying-question set: a prompt, the options the agent offered, how
/// many may be chosen, and whether free text is accepted. Ids are
/// AgentRoom-minted (`set-<n>`, `opt-<n>`); `header` is the runner's short chip
/// label when it supplied one; a `sensitive` set is free-text only, entered
/// securely, and its text is never echoed back on the stream.
public struct CodingQuestionSet: Codable, Hashable, Identifiable, Sendable {
    public var setId: String
    public var header: String?
    public var prompt: String
    public var selection: String
    public var options: [CodingQuestionOption]
    public var discussion: String
    public var sensitive: Bool?

    public var id: String { setId }

    public var allowsMultipleSelection: Bool { selection == CodingQuestionSelection.multiple }
    public var allowsDiscussion: Bool { discussion != CodingQuestionDiscussion.none }
    public var requiresDiscussion: Bool { discussion == CodingQuestionDiscussion.required }
    public var isSensitive: Bool { sensitive ?? false }

    public init(
        setId: String,
        header: String? = nil,
        prompt: String,
        selection: String = CodingQuestionSelection.single,
        options: [CodingQuestionOption],
        discussion: String = CodingQuestionDiscussion.optional,
        sensitive: Bool? = nil
    ) {
        self.setId = setId
        self.header = header
        self.prompt = prompt
        self.selection = selection
        self.options = options
        self.discussion = discussion
        self.sensitive = sensitive
    }
}
