import Foundation

/// A plan read failure that a client must not show as an absent plan. Other
/// failures surface as `APIClientError`: `.unauthorized` for a `401`, and
/// `.server` for any other non-success status.
public enum AgentSessionPlanReadError: LocalizedError, Equatable {
    /// The backend predates plans and never registered the route.
    case unsupportedBackend
    /// The route exists and the session does not.
    case sessionNotFound(String)
    /// `503`: the backend is still resolving the plan's state. Retry.
    case unavailable(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedBackend:
            return "This backend does not support thread plans."
        case .sessionNotFound(let message), .unavailable(let message):
            return message
        }
    }
}
