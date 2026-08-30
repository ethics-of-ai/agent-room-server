import Foundation

/// Lossless rather than a closed enum: a newer backend's event type must not
/// fail the whole payload decode and make the client drop an event it could
/// otherwise ignore gracefully. Unknown values round-trip as themselves.
///
/// Consequence at call sites: a `switch` over this is no longer exhaustive and
/// needs a `default`, which is the point — an unhandled future type is a
/// no-op, not a decode failure.
public struct CodingAgentEventType: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let sessionStarted = CodingAgentEventType(rawValue: "coding_session_started")
    public static let sessionRestored = CodingAgentEventType(rawValue: "coding_session_restored")
    public static let turnStarted = CodingAgentEventType(rawValue: "coding_turn_started")
    public static let tokenUsageUpdated = CodingAgentEventType(rawValue: "coding_token_usage_updated")
    public static let assistantMessageDelta = CodingAgentEventType(rawValue: "coding_assistant_message_delta")
    public static let planUpdated = CodingAgentEventType(rawValue: "coding_plan_updated")
    public static let diffUpdated = CodingAgentEventType(rawValue: "coding_diff_updated")
    public static let artifactStarted = CodingAgentEventType(rawValue: "coding_artifact_started")
    public static let artifactDelta = CodingAgentEventType(rawValue: "coding_artifact_delta")
    public static let artifactCompleted = CodingAgentEventType(rawValue: "coding_artifact_completed")
    public static let toolActivityStarted = CodingAgentEventType(rawValue: "coding_tool_activity_started")
    public static let toolActivityUpdated = CodingAgentEventType(rawValue: "coding_tool_activity_updated")
    public static let toolActivityCompleted = CodingAgentEventType(rawValue: "coding_tool_activity_completed")
    public static let permissionRequested = CodingAgentEventType(rawValue: "coding_permission_requested")
    public static let permissionResolved = CodingAgentEventType(rawValue: "coding_permission_resolved")
    public static let questionRequested = CodingAgentEventType(rawValue: "coding_question_requested")
    public static let questionResolved = CodingAgentEventType(rawValue: "coding_question_resolved")
    public static let contextCompactionStarted = CodingAgentEventType(rawValue: "coding_context_compaction_started")
    public static let contextCompactionCompleted = CodingAgentEventType(rawValue: "coding_context_compaction_completed")
    public static let turnCompleted = CodingAgentEventType(rawValue: "coding_turn_completed")
    public static let turnFailed = CodingAgentEventType(rawValue: "coding_turn_failed")
    public static let turnCancelled = CodingAgentEventType(rawValue: "coding_turn_cancelled")
}
