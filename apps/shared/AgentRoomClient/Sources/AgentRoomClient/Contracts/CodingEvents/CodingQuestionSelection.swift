import Foundation

/// How many options a set takes, as reported on `coding_question_requested`.
/// Open-ended by construction: an unknown value renders as single-select.
public enum CodingQuestionSelection {
    public static let single = "single"
    public static let multiple = "multiple"
}
