import Foundation

extension APIClient {
    public func testCodingAgentConnection(runnerKind: String) async throws -> CodingAgentConnectionTestResponse {
        try await request(
            ["api", "coding-agent", "connection-test"], method: "POST",
            body: JSONEncoder().encode(["runnerKind": runnerKind])
        )
    }
}
