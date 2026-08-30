import Foundation

/// Whether a set invites free text ("discuss further") beside a choice
/// (`optional`), instead of one (`required`), or not at all (`none`). Open-ended
/// by construction: an unknown value renders as `optional`.
public enum CodingQuestionDiscussion {
    public static let none = "none"
    public static let optional = "optional"
    public static let required = "required"
}
