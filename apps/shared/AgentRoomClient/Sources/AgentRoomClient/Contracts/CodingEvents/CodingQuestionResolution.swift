import Foundation

/// How a clarifying-question batch settled, as reported on
/// `coding_question_resolved`: `answered` by a person, `timeout` when the
/// bounded wait ran out (the runner applied its own away fallback), or
/// `cancelled` with the turn. Open-ended like every other vocabulary here.
public enum CodingQuestionResolution {
    public static let answered = "answered"
    public static let timeout = "timeout"
    public static let cancelled = "cancelled"
}
