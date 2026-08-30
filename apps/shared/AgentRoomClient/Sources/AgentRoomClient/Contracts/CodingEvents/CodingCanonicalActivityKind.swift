import Foundation

/// The runner-agnostic reading of one activity. A client decides what an
/// activity *is* from this, never from the activity's native `kind` string —
/// that is what lets a runner the app has never heard of render correctly.
///
/// Lossless for the same reason as `CodingAgentEventType`: an unrecognized
/// canonical kind degrades to a generic tool row rather than failing a decode.
public struct CodingCanonicalActivityKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let sessionStarted = CodingCanonicalActivityKind(rawValue: "session_started")
    public static let turnStarted = CodingCanonicalActivityKind(rawValue: "turn_started")
    public static let planUpdated = CodingCanonicalActivityKind(rawValue: "plan_updated")
    public static let diffUpdated = CodingCanonicalActivityKind(rawValue: "diff_updated")
    public static let reasoning = CodingCanonicalActivityKind(rawValue: "reasoning")
    public static let toolStarted = CodingCanonicalActivityKind(rawValue: "tool_started")
    public static let toolOutput = CodingCanonicalActivityKind(rawValue: "tool_output")
    public static let toolCompleted = CodingCanonicalActivityKind(rawValue: "tool_completed")
    public static let permissionRequested = CodingCanonicalActivityKind(rawValue: "permission_requested")
    public static let permissionResolved = CodingCanonicalActivityKind(rawValue: "permission_resolved")
    public static let questionRequested = CodingCanonicalActivityKind(rawValue: "question_requested")
    public static let questionResolved = CodingCanonicalActivityKind(rawValue: "question_resolved")
    public static let contextCompactionStarted = CodingCanonicalActivityKind(rawValue: "context_compaction_started")
    public static let contextCompactionCompleted = CodingCanonicalActivityKind(rawValue: "context_compaction_completed")
}
