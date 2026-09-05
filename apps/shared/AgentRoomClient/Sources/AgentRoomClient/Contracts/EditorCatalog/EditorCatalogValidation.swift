import Foundation

public enum EditorCatalogValidationState: String, Codable, Hashable, Sendable {
    case accepted
    case fallback
    case rejected
    case unavailable
}

/// Bounded catalog validation metadata. It deliberately carries no asset text.
public struct EditorCatalogValidation: Codable, Hashable, Sendable {
    public var state: EditorCatalogValidationState
    public var code: String?
    public var location: String?

    public init(state: EditorCatalogValidationState, code: String? = nil, location: String? = nil) {
        self.state = state
        self.code = code
        self.location = location
    }

    public static let accepted = EditorCatalogValidation(state: .accepted)
}
