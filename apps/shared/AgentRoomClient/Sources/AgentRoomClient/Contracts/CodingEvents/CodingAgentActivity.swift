import Foundation

public struct CodingAgentActivity: Codable, Hashable, Identifiable, Sendable {
    /// The runner's own name for the activity. Display and diagnostics only —
    /// `canonical` is what a client should read to decide what this is.
    public var kind: String
    public var title: String
    public var description: String?
    public var content: [String: JSONValue]
    public var canonical: CodingCanonicalActivity?
    public var runner: CodingRunnerMetadata?
    /// Legacy per-runner blocks, dual-emitted by the backend while the coding
    /// event contract floor is below 2. Prefer `runner`.
    public var codex: CodingAgentCodexMetadata?
    public var claudeCode: CodingAgentClaudeCodeMetadata?

    /// Identity comes from the canonical tool id first, then the runner
    /// envelope's native item id — never from Codex metadata alone, which only
    /// one runner populates.
    public var id: String {
        canonicalToolId ?? runner?.nativeItemId ?? codex?.itemId ?? "\(kind):\(title)"
    }

    /// The stable per-tool-call id a client correlates a start, its output, and
    /// its completion by, in canonical-first order.
    public var canonicalToolId: String? {
        if let toolId = canonical?.toolId, !toolId.isEmpty { return toolId }
        return nil
    }

    public init(
        kind: String,
        title: String,
        description: String? = nil,
        content: [String: JSONValue],
        canonical: CodingCanonicalActivity? = nil,
        runner: CodingRunnerMetadata? = nil,
        codex: CodingAgentCodexMetadata? = nil,
        claudeCode: CodingAgentClaudeCodeMetadata? = nil
    ) {
        self.kind = kind
        self.title = title
        self.description = description
        self.content = content
        self.canonical = canonical
        self.runner = runner
        self.codex = codex
        self.claudeCode = claudeCode
    }
}
