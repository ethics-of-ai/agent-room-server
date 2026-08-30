import Foundation

public struct CodingAgentEventPayload: Codable, Hashable, Sendable {
    public var type: CodingAgentEventType
    public var version: Int
    public var sessionId: String
    public var turnId: String?
    public var runnerKind: String
    public var runner: CodingRunnerMetadata?
    /// Legacy per-runner blocks, dual-emitted while the coding event contract
    /// floor is below 2. Prefer `runner`.
    public var codex: CodingAgentCodexMetadata?
    public var claudeCode: CodingAgentClaudeCodeMetadata?
    public var inputTokens: Int?
    public var cachedInputTokens: Int?
    public var outputTokens: Int?
    public var reasoningOutputTokens: Int?
    public var totalTokens: Int?
    /// Live context-window occupancy (latest request footprint); `totalTokens`
    /// remains the cumulative billed total for the turn.
    public var contextWindowUsedTokens: Int?
    public var modelContextWindowTokens: Int?
    /// On `coding_token_usage_updated`, where the runner auto-compacts. A JSON
    /// number replaces the cached value, explicit null clears it, and omission
    /// carries no new knowledge. Swift's optional collapses null and omission;
    /// use `AgentRoomEvent.hasExplicitNullValue(for:)` when applying the event.
    public var contextCompactionThresholdTokens: Int?
    /// On `coding_context_compaction_completed`: what asked for the compaction
    /// (`auto` or `manual`), and the occupancy either side of it. Every one of
    /// these is optional because the runners report different amounts, and a
    /// compaction with no counts is still worth showing.
    ///
    /// The compaction's own summary is never here. It is the model's account of
    /// the whole conversation and it stops at the backend's adapter.
    public var trigger: String?
    public var preTokens: Int?
    public var postTokens: Int?
    /// The compaction was attempted and did not succeed, so occupancy did not
    /// fall. Reads very differently from a compaction that worked.
    public var failed: Bool?
    public var delta: String?
    public var explanation: String?
    public var plan: [CodingPlanStep]?
    public var summary: String?
    public var files: [CodingDiffFile]?
    public var activity: CodingAgentActivity?
    public var request: [String: JSONValue]?
    public var requestId: String?
    /// The answers the agent offered, on `coding_permission_requested`. Present
    /// only for a runner whose request can actually be answered; a runner that
    /// decides from its own stored posture sends none, and the event stays the
    /// transcript entry it always was.
    public var options: [CodingPermissionOption]?
    public var status: String?
    /// On `coding_permission_resolved`: the option that was selected, and who
    /// selected it (`human`, `policy`, `timeout`). Surface the authority —
    /// "allowed" reads very differently depending on who allowed it.
    public var optionId: String?
    public var decidedBy: String?
    /// On `coding_question_requested`: the sets of a clarifying-question batch.
    /// With `requestId` they are answerable through
    /// `POST /api/agent-sessions/:id/questions/:requestId`; without it the
    /// batch is a record a client renders but cannot answer, the same rule as
    /// `options` on a permission request.
    public var questionSets: [CodingQuestionSet]?
    /// On `coding_question_resolved` after a human answer: what was chosen per
    /// answered set. `status` and `decidedBy` above say how the batch settled.
    public var questionAnswers: [CodingQuestionAnswer]?
    public var error: String?
    // Live artifact channel: `artifactId` and `kind` ("svg" | "mermaid") on
    // started, `delta` on delta (reuses the field above), and `bytes` on
    // completed. `truncated` applies to completed artifacts and bounded diff
    // summaries.
    public var artifactId: String?
    public var kind: String?
    public var title: String?
    public var bytes: Int?
    public var truncated: Bool?

    public init(
        type: CodingAgentEventType,
        version: Int,
        sessionId: String,
        turnId: String? = nil,
        runnerKind: String,
        runner: CodingRunnerMetadata? = nil,
        codex: CodingAgentCodexMetadata? = nil,
        claudeCode: CodingAgentClaudeCodeMetadata? = nil,
        inputTokens: Int? = nil,
        cachedInputTokens: Int? = nil,
        outputTokens: Int? = nil,
        reasoningOutputTokens: Int? = nil,
        totalTokens: Int? = nil,
        contextWindowUsedTokens: Int? = nil,
        modelContextWindowTokens: Int? = nil,
        contextCompactionThresholdTokens: Int? = nil,
        trigger: String? = nil,
        preTokens: Int? = nil,
        postTokens: Int? = nil,
        failed: Bool? = nil,
        delta: String? = nil,
        explanation: String? = nil,
        plan: [CodingPlanStep]? = nil,
        summary: String? = nil,
        files: [CodingDiffFile]? = nil,
        activity: CodingAgentActivity? = nil,
        request: [String: JSONValue]? = nil,
        requestId: String? = nil,
        options: [CodingPermissionOption]? = nil,
        status: String? = nil,
        optionId: String? = nil,
        decidedBy: String? = nil,
        questionSets: [CodingQuestionSet]? = nil,
        questionAnswers: [CodingQuestionAnswer]? = nil,
        error: String? = nil,
        artifactId: String? = nil,
        kind: String? = nil,
        title: String? = nil,
        bytes: Int? = nil,
        truncated: Bool? = nil
    ) {
        self.type = type
        self.version = version
        self.sessionId = sessionId
        self.turnId = turnId
        self.runnerKind = runnerKind
        self.runner = runner
        self.codex = codex
        self.claudeCode = claudeCode
        self.inputTokens = inputTokens
        self.cachedInputTokens = cachedInputTokens
        self.outputTokens = outputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.totalTokens = totalTokens
        self.contextWindowUsedTokens = contextWindowUsedTokens
        self.modelContextWindowTokens = modelContextWindowTokens
        self.contextCompactionThresholdTokens = contextCompactionThresholdTokens
        self.trigger = trigger
        self.preTokens = preTokens
        self.postTokens = postTokens
        self.failed = failed
        self.delta = delta
        self.explanation = explanation
        self.plan = plan
        self.summary = summary
        self.files = files
        self.activity = activity
        self.request = request
        self.requestId = requestId
        self.options = options
        self.status = status
        self.optionId = optionId
        self.decidedBy = decidedBy
        self.questionSets = questionSets
        self.questionAnswers = questionAnswers
        self.error = error
        self.artifactId = artifactId
        self.kind = kind
        self.title = title
        self.bytes = bytes
        self.truncated = truncated
    }
}
