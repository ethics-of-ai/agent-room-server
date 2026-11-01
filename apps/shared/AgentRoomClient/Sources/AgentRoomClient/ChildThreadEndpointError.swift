import Foundation

/// A child-thread route refusal with the backend's `code` kept, so the UI can
/// react to it: offer Update from parent after `not_fast_forward`, open the
/// child's change review after `child_dirty`. `message` is the backend's
/// `error` text. A `401` throws `APIClientError.unauthorized` instead.
/// API.md, section Child threads, lists the codes per route.
public struct ChildThreadEndpointError: LocalizedError, Equatable, Sendable {
    public let statusCode: Int
    /// The backend's refusal code, such as `child_running`, `child_dirty`,
    /// `not_fast_forward` or `child_limit_reached`. Nil when the body has none.
    public let code: String?
    public let message: String
    /// The backend predates child threads and never registered the route.
    public let isUnsupportedBackend: Bool

    public init(statusCode: Int, code: String?, message: String, isUnsupportedBackend: Bool = false) {
        self.statusCode = statusCode
        self.code = code
        self.message = message
        self.isUnsupportedBackend = isUnsupportedBackend
    }

    public var errorDescription: String? { message }

    /// Land refused because the parent branch moved past the child's base.
    public var needsUpdateFromParent: Bool { code == "not_fast_forward" }

    /// Land, Update or Close refused because the child's worktree has
    /// uncommitted changes.
    public var childHasUncommittedChanges: Bool { code == "child_dirty" }
}
