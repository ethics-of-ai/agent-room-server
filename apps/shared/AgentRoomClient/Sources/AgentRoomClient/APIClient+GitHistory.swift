import Foundation

extension APIClient {
    public func fetchGitHistory(workspaceId: String, branch: String? = nil, compare: String? = nil,
                                limit: Int = 100) async throws -> WorkspaceGitHistory {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let branch { query.append(URLQueryItem(name: "branch", value: branch)) }
        if let compare { query.append(URLQueryItem(name: "compare", value: compare)) }
        return try await request(["api", "workspaces", workspaceId, "git", "history"], queryItems: query)
    }

    public func fetchGitCommit(workspaceId: String, commit: String) async throws -> WorkspaceGitCommitDetail {
        try await request(["api", "workspaces", workspaceId, "git", "commit"], queryItems: [
            URLQueryItem(name: "commit", value: commit)
        ])
    }

    public func fetchGitCommitDiff(workspaceId: String, commit: String, path: String) async throws -> WorkspaceGitCommitDiff {
        try await request(["api", "workspaces", workspaceId, "git", "commit-file"], queryItems: [
            URLQueryItem(name: "commit", value: commit), URLQueryItem(name: "path", value: path)
        ])
    }
}
