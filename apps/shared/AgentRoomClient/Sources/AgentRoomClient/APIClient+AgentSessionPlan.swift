import Foundation

extension APIClient {
    /// The thread's plan, or a nil `plan` when it has none. Bearer-gated like
    /// the transcript because the plan is model-authored content. Read it again
    /// after `AgentPlanChangedEvent`, on reconnect, and when a turn settles; the
    /// event carries only the plan id and revision.
    ///
    /// Neither a `404` nor a `503` is an absent plan, so both throw
    /// `AgentSessionPlanReadError`. A backend that predates plans answers the
    /// route with Fastify's default route-miss body, which becomes
    /// `.unsupportedBackend`; any other `404` is `.sessionNotFound`. A `503`
    /// means the backend is still resolving a plan write and has no
    /// authoritative snapshot, so the caller retries.
    public func fetchAgentSessionPlan(sessionId: String) async throws -> AgentSessionPlanResponse {
        var request = URLRequest(url: try url(pathSegments: ["api", "agent-sessions", sessionId, "plan"]))
        request.httpMethod = "GET"
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.planReadError(statusCode: http.statusCode, body: data)
        }
        do {
            return try JSONDecoder().decode(AgentSessionPlanResponse.self, from: data)
        } catch {
            throw APIClientError.invalidResponse("Backend response did not match the expected shape.")
        }
    }

    private static func planReadError(statusCode: Int, body: Data) -> Error {
        struct ErrorBody: Decodable {
            var error: String?
            var message: String?
            var statusCode: Int?
        }
        let decoded = try? JSONDecoder().decode(ErrorBody.self, from: body)
        let message = decoded?.error ?? decoded?.message ?? "Backend returned HTTP \(statusCode)."
        switch statusCode {
        case 401:
            return APIClientError.unauthorized
        case 404:
            // Fastify's route miss carries `statusCode` and a "Route GET:…"
            // message; the plan route's own 404 carries only `error`.
            let isRouteMiss = decoded?.statusCode == 404 && decoded?.message?.hasPrefix("Route ") == true
            return isRouteMiss
                ? AgentSessionPlanReadError.unsupportedBackend
                : AgentSessionPlanReadError.sessionNotFound(message)
        case 503:
            return AgentSessionPlanReadError.unavailable(message)
        default:
            return APIClientError.server(decoded?.message ?? message)
        }
    }
}
