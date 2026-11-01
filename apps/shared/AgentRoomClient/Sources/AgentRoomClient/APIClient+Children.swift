import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension APIClient {
    /// Starts a child thread of `parentSessionId` in a new linked worktree,
    /// on a new `agentroom/…` branch cut from the parent checkout's HEAD. The
    /// child's first turn is already running when this returns. A nil
    /// `runnerKind` uses the parent's runner.
    public func createChildThread(
        parentSessionId: String,
        title: String,
        task: String,
        runnerKind: String? = nil,
        settings: CodingAgentTurnSettings? = nil
    ) async throws -> ChildThreadCreateResponse {
        try await childThreadRequest(
            ["api", "agent-sessions", parentSessionId, "children"],
            method: "POST",
            body: JSONEncoder().encode(ChildThreadCreateRequest(
                title: title, task: task, runnerKind: runnerKind, settings: settings
            ))
        )
    }

    /// The parent's open children, or every child with `includeClosed`. Read
    /// it again after `AgentChildChangedEvent` and when a child's turn
    /// settles.
    public func fetchChildThreads(parentSessionId: String, includeClosed: Bool = false) async throws -> ChildThreadListResponse {
        try await childThreadRequest(
            ["api", "agent-sessions", parentSessionId, "children"],
            queryItems: includeClosed ? [URLQueryItem(name: "include", value: "closed")] : []
        )
    }

    /// Fast-forwards the parent checkout's current branch to the child's
    /// branch. It never makes a merge commit.
    public func landChildThread(sessionId: String) async throws -> ChildThreadGitResponse {
        try await childThreadRequest(["api", "agent-sessions", sessionId, "land"], method: "POST")
    }

    /// Merges the parent checkout's current branch into the child's branch. A
    /// conflict is aborted at once and refuses with `update_conflicted`.
    public func updateChildThreadFromParent(sessionId: String) async throws -> ChildThreadGitResponse {
        try await childThreadRequest(["api", "agent-sessions", sessionId, "update-from-parent"], method: "POST")
    }

    /// Removes the child's worktree and workspace, deletes its branch unless
    /// that would lose commits, and marks the child closed. The transcript
    /// stays readable.
    public func closeChildThread(sessionId: String) async throws -> ChildThreadCloseResponse {
        try await childThreadRequest(["api", "agent-sessions", sessionId, "close"], method: "POST")
    }

    // MARK: - Plumbing

    /// The child routes' requests, with refusals decoded so the `code` stays.
    private func childThreadRequest<T: Decodable>(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        queryItems: [URLQueryItem] = []
    ) async throws -> T {
        try await codedRefusalRequest(pathSegments, method: method, body: body, queryItems: queryItems) { statusCode, body in
            Self.childThreadError(statusCode: statusCode, body: body)
        }
    }

    private static func childThreadError(statusCode: Int, body decoded: CodedRefusalBody?) -> Error {
        if statusCode == 401 {
            return APIClientError.unauthorized
        }
        // Fastify's route miss carries `statusCode` and a "Route POST:…"
        // message; the child routes' own refusals carry `error` and `code`.
        let isRouteMiss = statusCode == 404 && decoded?.statusCode == 404 && decoded?.message?.hasPrefix("Route ") == true
        return ChildThreadEndpointError(
            statusCode: statusCode,
            code: isRouteMiss ? nil : decoded?.code,
            message: isRouteMiss
                ? "This backend does not support child threads."
                : decoded?.error ?? decoded?.message ?? "Backend returned HTTP \(statusCode).",
            isUnsupportedBackend: isRouteMiss
        )
    }
}
