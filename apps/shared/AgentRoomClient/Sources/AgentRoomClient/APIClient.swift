import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum APIClientError: LocalizedError, Equatable {
    case unauthorized
    case server(String)
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Bearer token was rejected by the AgentRoom backend."
        case .server(let message):
            return message
        case .invalidResponse(let message):
            return message
        }
    }
}

public struct APIClient {
    public var serverBaseURL: URL
    public var authToken: String

    var urlSession: URLSession

    public init(serverBaseURL: URL, authToken: String, urlSession: URLSession = .shared) {
        self.serverBaseURL = serverBaseURL
        self.authToken = authToken
        self.urlSession = urlSession
    }

    public func fetchHealth() async throws -> HealthResponse {
        try await request("health")
    }

    public func checkAuth() async throws -> AuthCheckResponse {
        try await request("api/auth/check")
    }

    public func fetchStatus() async throws -> StatusSnapshot {
        try await request("api/status")
    }

    public func fetchPublicConfig() async throws -> PublicServiceConfig {
        try await request("api/config")
    }

    /// The runners this backend registers, with the availability states it
    /// resolved for each. Ungated like `/api/config`, and for the same reason:
    /// it reports the operator's posture, never their credentials.
    ///
    /// A client hydrates its `RunnerCatalog` from this instead of compiling the
    /// list in, so a runner the backend registers can be offered without
    /// shipping the app again. A backend that predates the route answers `404`,
    /// which surfaces as `APIClientError.server` — remote callers fall back to
    /// `RunnerCatalog.legacyBackendFallback` rather than treating it as a
    /// connection failure. The Mac has its separate full offline floor.
    public func fetchRunners() async throws -> RunnerCatalogResponse {
        try await request("api/runners")
    }

    /// Merges a partial patch into the backend-owned managed settings file and
    /// returns the refreshed `/api/config` projection, so the caller re-renders
    /// its whole settings surface from this one reply.
    ///
    /// Keys are managed setting names (the ones `/api/config` reports in its
    /// `settings` block); an absent key is left untouched and `.null` clears a
    /// key back to the backend's code default. Unknown keys are a `400` rather
    /// than a silent no-op, and tier-3 names — `AUTH_TOKEN`, executable paths,
    /// host/port, the storage directories — are not managed keys at all, so
    /// they are refused the same way.
    ///
    /// Everything here applies on the **next backend restart**, which only the
    /// Mac app can perform. A `403` means the patch named a trust-posture
    /// (tier-2) key while the Mac-side `REMOTE_SETTINGS_ADMIN` switch is off; a
    /// `409` means an environment variable on the Mac has locked the key (or the
    /// settings file on disk cannot be parsed). Both arrive as
    /// `APIClientError.server` carrying the backend's explanation.
    public func patchManagedSettings(_ patch: [String: JSONValue]) async throws -> PublicServiceConfig {
        try await request(
            "api/config",
            method: "PATCH",
            body: try JSONEncoder().encode(patch)
        )
    }

    public func fetchCodingAgentCapabilities(runnerKind: String? = nil) async throws -> CodingAgentCapabilitiesResponse {
        let queryItems = runnerKind.map { [URLQueryItem(name: "runnerKind", value: $0)] } ?? []
        return try await request(["api", "coding-agent", "capabilities"], queryItems: queryItems)
    }

    public func fetchWorkspaces() async throws -> LocalWorkspaceRegistrySnapshot {
        try await request("api/workspaces")
    }

    public func registerWorkspace(path: String, kind: String = "user_selected") async throws -> LocalWorkspace {
        let payload = RegisterWorkspaceRequest(path: path, kind: kind)
        let response: RegisterWorkspaceResponse = try await request(
            "api/workspaces",
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return response.workspace
    }

    public func unregisterWorkspace(workspaceId: String) async throws {
        _ = try await requestData(["api", "workspaces", workspaceId], method: "DELETE")
    }

    public func fetchWorkspaceTree(
        workspaceId: String,
        path: String = "",
        depth: Int = 3
    ) async throws -> WorkspaceTreeSnapshot {
        try await request(
            ["api", "workspaces", workspaceId, "tree"],
            queryItems: [
                URLQueryItem(name: "path", value: path),
                URLQueryItem(name: "depth", value: "\(depth)")
            ]
        )
    }

    /// Loads a bounded UTF-8 preview of a workspace file. `maxBytes` raises the read
    /// cap from the 24 KB browse default up to the backend write cap so the editor can
    /// load (and then save) larger files; omit it for browse-sized previews.
    public func fetchWorkspaceFilePreview(
        workspaceId: String,
        path: String,
        maxBytes: Int? = nil
    ) async throws -> WorkspaceFilePreview {
        var queryItems = [URLQueryItem(name: "path", value: path)]
        if let maxBytes {
            queryItems.append(URLQueryItem(name: "maxBytes", value: "\(maxBytes)"))
        }
        return try await request(
            ["api", "workspaces", workspaceId, "file-preview"],
            queryItems: queryItems
        )
    }

    /// Backend cap on `GET /api/workspaces/:id/files` results.
    private static let maxFileIndexResults = 200
    /// Backend cap on `GET /api/workspaces/:id/search`. It bounds *total
    /// matches* across the run, not the number of files.
    private static let maxSearchMatches = 500

    /// Lists a ranked, bounded slice of a registered workspace's file index for
    /// quick-open and the `@` mention picker. An empty `query` returns the
    /// unfiltered head of the index. `limit` is clamped into the backend's
    /// 1...200 range; omit it to take the backend default (50).
    public func fetchWorkspaceFileIndex(
        workspaceId: String,
        query: String = "",
        limit: Int? = nil
    ) async throws -> WorkspaceFileIndexSnapshot {
        var queryItems: [URLQueryItem] = []
        if !query.isEmpty {
            queryItems.append(URLQueryItem(name: "query", value: query))
        }
        if let limit {
            queryItems.append(
                URLQueryItem(name: "limit", value: "\(clampedLimit(limit, upperBound: Self.maxFileIndexResults))")
            )
        }
        return try await request(
            ["api", "workspaces", workspaceId, "files"],
            queryItems: queryItems
        )
    }

    /// Runs a bounded, read-only content search over a registered workspace.
    /// `query` is required and is matched as a literal substring — the backend
    /// accepts no regex — and it is trimmed and capped at 200 characters
    /// server-side, so a blank query is rejected with a 400. `include` is an
    /// optional simple glob over workspace-relative paths. `limit` bounds total
    /// matches rather than files and is clamped into the backend's 1...500
    /// range; omit it to take the backend default (500).
    public func searchWorkspaceFiles(
        workspaceId: String,
        query: String,
        matchCase: Bool = false,
        wholeWord: Bool = false,
        include: String? = nil,
        limit: Int? = nil
    ) async throws -> WorkspaceSearchSnapshot {
        var queryItems = [
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "matchCase", value: String(matchCase)),
            URLQueryItem(name: "wholeWord", value: String(wholeWord))
        ]
        if let include, !include.isEmpty {
            queryItems.append(URLQueryItem(name: "include", value: include))
        }
        if let limit {
            queryItems.append(
                URLQueryItem(name: "limit", value: "\(clampedLimit(limit, upperBound: Self.maxSearchMatches))")
            )
        }
        return try await request(
            ["api", "workspaces", workspaceId, "search"],
            queryItems: queryItems
        )
    }

    public func fetchWorkspaceGitStatus(workspaceId: String) async throws -> LocalWorkspaceGitStatus {
        try await request(["api", "workspaces", workspaceId, "git", "status"])
    }

    /// Fetches the composed spatial scene for a base scene path
    /// (`<name>.scene.json`). The response carries the composed document plus
    /// the `modifiedAt` optimistic-lock tokens for the next override write;
    /// override writes themselves go through `writeWorkspaceFile`.
    public func fetchSpatialScene(workspaceId: String, path: String) async throws -> SpatialSceneSnapshotResponse {
        try await request(
            ["api", "workspaces", workspaceId, "spatial-scene"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
    }

    /// Loads the git HEAD version of a workspace file so an editor can render
    /// working-tree change decorations. `maxBytes` bounds the returned content
    /// like `fetchWorkspaceFilePreview`; the backend defaults it to the write cap.
    public func fetchWorkspaceGitFileBaseline(
        workspaceId: String,
        path: String,
        maxBytes: Int? = nil
    ) async throws -> WorkspaceGitFileBaseline {
        var queryItems = [URLQueryItem(name: "path", value: path)]
        if let maxBytes {
            queryItems.append(URLQueryItem(name: "maxBytes", value: "\(maxBytes)"))
        }
        return try await request(
            ["api", "workspaces", workspaceId, "git", "file-base"],
            queryItems: queryItems
        )
    }

    /// Lists the skills a runner kind would natively load from a registered
    /// workspace, for the composer's slash picker. Omit `runnerKind` to use the
    /// backend's default runner.
    public func fetchWorkspaceSkills(
        workspaceId: String,
        runnerKind: String? = nil
    ) async throws -> WorkspaceSkillsSnapshot {
        let queryItems = runnerKind.map { [URLQueryItem(name: "runnerKind", value: $0)] } ?? []
        return try await request(
            ["api", "workspaces", workspaceId, "skills"],
            queryItems: queryItems
        )
    }

    public func writeWorkspaceFile(
        workspaceId: String,
        path: String,
        content: String,
        baseModifiedAt: String? = nil
    ) async throws -> WorkspaceFilePreview {
        let payload = WorkspaceFileWriteRequest(path: path, content: content, baseModifiedAt: baseModifiedAt)
        return try await request(
            ["api", "workspaces", workspaceId, "file"],
            method: "PUT",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Deletes one regular workspace file only when `baseModifiedAt` still
    /// matches the version the client rendered. Directories and blind deletes
    /// are refused by the backend.
    public func deleteWorkspaceFile(
        workspaceId: String,
        path: String,
        baseModifiedAt: String
    ) async throws -> WorkspaceFileDeleteResponse {
        let payload = WorkspaceFileDeleteRequest(path: path, baseModifiedAt: baseModifiedAt)
        return try await request(
            ["api", "workspaces", workspaceId, "file"],
            method: "DELETE",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Creates one directory whose parent already exists. Deliberately not
    /// recursive — the backend creates a single leaf, the same rule
    /// `writeWorkspaceFile` follows — and create-only, so an occupied name comes
    /// back as a conflict instead of quietly resolving to the existing folder.
    public func createWorkspaceDirectory(
        workspaceId: String,
        path: String
    ) async throws -> WorkspaceDirectoryCreateResponse {
        let payload = WorkspaceDirectoryCreateRequest(path: path)
        return try await request(
            ["api", "workspaces", workspaceId, "directory"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Recursively deletes one directory only when `baseModifiedAt` still
    /// matches the version the client rendered. The backend preflights the
    /// complete subtree and refuses protected, linked, or oversized content.
    public func deleteWorkspaceDirectory(
        workspaceId: String,
        path: String,
        baseModifiedAt: String
    ) async throws -> WorkspaceDirectoryDeleteResponse {
        let payload = WorkspaceDirectoryDeleteRequest(path: path, baseModifiedAt: baseModifiedAt)
        return try await request(
            ["api", "workspaces", workspaceId, "directory"],
            method: "DELETE",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Renames a regular file or directory within its current parent. `newName`
    /// is one leaf name rather than a path, so this endpoint cannot move entries.
    public func renameWorkspaceEntry(
        workspaceId: String,
        path: String,
        newName: String,
        baseModifiedAt: String
    ) async throws -> WorkspaceEntryRenameResponse {
        let payload = WorkspaceEntryRenameRequest(
            path: path,
            newName: newName,
            baseModifiedAt: baseModifiedAt
        )
        return try await request(
            ["api", "workspaces", workspaceId, "entry", "rename"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Moves a regular file or directory to another folder in the same
    /// workspace. It runs the same optimistic-locked, no-overwrite relocation
    /// rename runs; what it adds is a destination parent, which the backend
    /// bounds exactly as it bounds every other parent it writes into. Omitting
    /// `newName` keeps the entry's own name.
    public func moveWorkspaceEntry(
        workspaceId: String,
        path: String,
        destinationParent: String,
        newName: String? = nil,
        baseModifiedAt: String
    ) async throws -> WorkspaceEntryMoveResponse {
        let payload = WorkspaceEntryMoveRequest(
            path: path,
            destinationParent: destinationParent,
            newName: newName,
            baseModifiedAt: baseModifiedAt
        )
        return try await request(
            ["api", "workspaces", workspaceId, "entry", "move"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Copies a regular file or directory inside the same workspace. The bytes
    /// never transit this API, so the backend's subtree caps bound it rather
    /// than the 256 KB write cap, and it inventories the source before writing
    /// anything. `onCollision: .keepBoth` takes the next name on the backend's
    /// bounded ladder instead of refusing an occupied one.
    public func copyWorkspaceEntry(
        workspaceId: String,
        path: String,
        destinationParent: String,
        newName: String? = nil,
        baseModifiedAt: String,
        onCollision: WorkspaceEntryCopyRequest.CollisionStrategy? = nil
    ) async throws -> WorkspaceEntryCopyResponse {
        let payload = WorkspaceEntryCopyRequest(
            path: path,
            destinationParent: destinationParent,
            newName: newName,
            baseModifiedAt: baseModifiedAt,
            onCollision: onCollision
        )
        return try await request(
            ["api", "workspaces", workspaceId, "entry", "copy"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Converts Mermaid flowchart/graph source into canonical solution-diagram
    /// file content. Pure backend compute — nothing is written; the caller
    /// writes the returned `content` through `writeWorkspaceFile` itself, so
    /// the only mutation stays the bounded workspace file PUT.
    public func convertMermaidDiagram(
        source: String,
        name: String? = nil
    ) async throws -> SpatialDiagramMermaidImportResponse {
        let payload = SpatialDiagramMermaidImportRequest(source: source, name: name)
        return try await request(
            ["api", "spatial-scene", "mermaid-import"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    /// Applies a bounded list of semantic operations to a solution diagram's
    /// base document text and returns new canonical text. Pure backend compute
    /// — nothing is written; the caller writes the returned `content` through
    /// `writeWorkspaceFile` with the base layer's `modifiedAt` optimistic-lock
    /// token, so a concurrent agent regeneration surfaces as that PUT's 409.
    /// Omit `baseContent` to start from an empty document (the New Diagram
    /// path); `name` may only accompany that form.
    public func applyDiagramEdit(
        baseContent: String? = nil,
        name: String? = nil,
        ops: [SpatialDiagramEditOp]
    ) async throws -> SpatialDiagramEditResponse {
        let payload = SpatialDiagramEditRequest(baseContent: baseContent, name: name, ops: ops)
        return try await request(
            ["api", "spatial-scene", "diagram-edit"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    public func switchWorkspaceBranch(
        workspaceId: String,
        branch: String
    ) async throws -> WorkspaceBranchSwitchResponse {
        let payload = SwitchWorkspaceBranchRequest(branch: branch)
        return try await request(
            ["api", "workspaces", workspaceId, "git", "branch"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    // MARK: - Git operations
    //
    // The fixed mutating git surface. Each is a bearer-authed POST that runs one
    // fixed git command in the registered workspace and returns the refreshed
    // workspace plus status. Nothing here rewrites history and pull is
    // fast-forward only; see docs/safety/TRUST_AND_SAFETY.md.

    /// Stages `paths`, or every changed path when `all` is true. A secret-named
    /// or generated path is refused when named explicitly and skipped (reported
    /// in `skippedPaths`) when staging everything.
    public func stageWorkspaceGitPaths(
        workspaceId: String,
        paths: [String]? = nil,
        all: Bool = false
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["stage"], WorkspaceGitPathsRequest(paths: paths, all: all ? true : nil))
    }

    public func unstageWorkspaceGitPaths(
        workspaceId: String,
        paths: [String]? = nil,
        all: Bool = false
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["unstage"], WorkspaceGitPathsRequest(paths: paths, all: all ? true : nil))
    }

    /// Reverts each path to its HEAD content, deleting it when HEAD has no such
    /// file. Destructive and irreversible — confirm before calling.
    public func discardWorkspaceGitPaths(
        workspaceId: String,
        paths: [String]
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["discard"], WorkspaceGitPathsRequest(paths: paths))
    }

    /// Commits the staged tree, optionally staging everything first. The
    /// workspace's own commit hooks run, exactly as they would in a terminal.
    public func commitWorkspaceGit(
        workspaceId: String,
        message: String,
        stageAll: Bool = false
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(
            workspaceId,
            ["commit"],
            WorkspaceGitCommitRequest(message: message, stageAll: stageAll ? true : nil)
        )
    }

    public func fetchWorkspaceGit(workspaceId: String) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["fetch"], WorkspaceGitPushRequest())
    }

    /// Fast-forward only: a diverged branch fails with git's own message rather
    /// than producing a merge commit or a conflicted worktree.
    public func pullWorkspaceGit(workspaceId: String) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["pull"], WorkspaceGitPushRequest())
    }

    /// Pushes the current branch, publishing it with an upstream when it has none.
    public func pushWorkspaceGit(
        workspaceId: String,
        setUpstream: Bool = false
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["push"], WorkspaceGitPushRequest(setUpstream: setUpstream ? true : nil))
    }

    /// Creates a branch and switches to it, carrying uncommitted work along.
    public func createWorkspaceBranch(
        workspaceId: String,
        branch: String
    ) async throws -> WorkspaceGitOperationResult {
        try await gitOperation(workspaceId, ["branch", "create"], CreateWorkspaceBranchRequest(branch: branch))
    }

    private func gitOperation<Payload: Encodable>(
        _ workspaceId: String,
        _ pathComponents: [String],
        _ payload: Payload
    ) async throws -> WorkspaceGitOperationResult {
        try await request(
            ["api", "workspaces", workspaceId, "git"] + pathComponents,
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
    }

    public func fetchAgentSessions() async throws -> AgentSessionListResponse {
        try await request("api/agent-sessions")
    }

    public func fetchAgentSessionMessages(sessionId: String) async throws -> AgentSessionMessageListResponse {
        try await request(["api", "agent-sessions", sessionId, "messages"])
    }

    public func fetchAgentSessionArtifacts(sessionId: String) async throws -> AgentSessionArtifactListResponse {
        try await request(["api", "agent-sessions", sessionId, "artifacts"])
    }

    public func uploadAgentSessionAttachment(
        sessionId: String,
        sourceName: String,
        contentType: String,
        data: Data
    ) async throws -> AgentSessionAttachment {
        let boundary = "AgentRoomBoundary-\(UUID().uuidString)"
        let body = multipartBody(
            boundary: boundary,
            fieldName: "file",
            filename: sourceName,
            contentType: contentType,
            data: data
        )
        let response: AgentSessionAttachmentResponse = try await request(
            ["api", "agent-sessions", sessionId, "attachments"],
            method: "POST",
            body: body,
            contentType: "multipart/form-data; boundary=\(boundary)"
        )
        return response.attachment
    }

    public func createAgentSession(
        workspaceId: String,
        runnerKind: String? = nil,
        gitBranch: String? = nil,
        title: String? = nil,
        settings: CodingAgentTurnSettings? = nil
    ) async throws -> AgentSession {
        let payload = CreateAgentSessionRequest(
            workspaceId: workspaceId,
            runnerKind: runnerKind,
            gitBranch: gitBranch,
            settings: settings,
            title: title
        )
        let response: AgentSessionResponse = try await request(
            "api/agent-sessions",
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return response.session
    }

    public func sendAgentTurn(
        sessionId: String,
        message: String,
        contextPaths: [String] = [],
        attachmentIds: [String] = [],
        settings: CodingAgentTurnSettings? = nil
    ) async throws -> AgentSessionTurn {
        let context = (contextPaths.isEmpty && attachmentIds.isEmpty)
            ? nil
            : AgentTurnContext(
                paths: contextPaths.isEmpty ? nil : contextPaths,
                attachments: attachmentIds.isEmpty ? nil : attachmentIds
            )
        let payload = SendAgentTurnRequest(message: message, context: context, settings: settings)
        let response: AgentSessionTurnResponse = try await request(
            ["api", "agent-sessions", sessionId, "turns"],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return response.turn
    }

    public func cancelAgentSession(sessionId: String) async throws -> AgentSession {
        let response: AgentSessionResponse = try await request(
            ["api", "agent-sessions", sessionId, "cancel"],
            method: "POST"
        )
        return response.session
    }

    /// Answer a permission request a runner raised mid-turn with one of the
    /// options it offered (`coding_permission_requested` carries both the
    /// request id and the options). The backend refuses an option the agent did
    /// not supply, so this can express nothing the agent would not accept.
    public func answerPermissionRequest(
        sessionId: String,
        requestId: String,
        optionId: String
    ) async throws -> AgentSession {
        let payload = AnswerPermissionRequest(optionId: optionId)
        let response: AgentSessionResponse = try await request(
            ["api", "agent-sessions", sessionId, "permissions", requestId],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return response.session
    }

    /// Answer a clarifying-question batch a runner raised mid-turn: per answered
    /// set, option ids the agent offered and the person's free text where the
    /// set invited it (`coding_question_requested` carries the request id and
    /// the sets). A set left out stays unanswered. The backend refuses a set or
    /// option the agent did not offer, so this can express nothing the agent
    /// would not accept.
    public func answerQuestionRequest(
        sessionId: String,
        requestId: String,
        answers: [CodingQuestionAnswer]
    ) async throws -> AgentSession {
        let payload = AnswerQuestionRequest(answers: answers)
        let response: AgentSessionResponse = try await request(
            ["api", "agent-sessions", sessionId, "questions", requestId],
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return response.session
    }

    /// The clarifying-question batches a session still holds open, for a client
    /// that connected after the event replay rolled over. Bearer-gated like the
    /// transcript read, since question text is model-authored.
    public func outstandingQuestions(sessionId: String) async throws -> [OutstandingQuestionRequest] {
        let response: OutstandingQuestionsResponse = try await request(
            ["api", "agent-sessions", sessionId, "questions"],
            method: "GET"
        )
        return response.questions
    }

    public func deleteAgentSession(sessionId: String) async throws {
        _ = try await requestData(["api", "agent-sessions", sessionId], method: "DELETE")
    }

    /// Fetch the backend-served editor language catalog manifest. The
    /// editor injects these assets over its no-network bridge; when the backend has
    /// no catalog (404) the client falls back to its bundled editor assets.
    public func fetchEditorCatalog() async throws -> EditorCatalogManifest {
        let response: EditorCatalogResponse = try await request(["api", "editor", "catalog"])
        return response.catalog
    }

    /// Fetch one catalog blob (a grammar `.tmLanguage.json` or the Oniguruma
    /// `.wasm`) as raw bytes. The caller verifies the bytes against the manifest's
    /// `sha256` before use.
    public func fetchEditorCatalogAsset(path: String) async throws -> Data {
        try await requestData(
            ["api", "editor", "catalog", "asset"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
    }

    /// Operator-facing catalog status for the macOS catalog pane:
    /// whether the catalog is enabled, which directory it is served from, and the
    /// live version + language count.
    public func fetchEditorCatalogStatus() async throws -> EditorCatalogStatus {
        try await request(["api", "editor", "catalog", "status"])
    }

    /// Re-read the operator override (then bundled) catalog and swap in the new
    /// snapshot. When the version changes the backend broadcasts
    /// `editor_catalog_changed` so paired visionOS editors re-hydrate live.
    @discardableResult
    public func reloadEditorCatalog() async throws -> EditorCatalogReloadResult {
        try await request(["api", "editor", "catalog", "reload"], method: "POST")
    }

    public func fetchRaw(_ path: String) async throws -> String {
        let data = try await requestData(path.split(separator: "/").map(String.init))
        return String(data: data, encoding: .utf8) ?? "<non-UTF8 response>"
    }

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json"
    ) async throws -> T {
        try await request(path.split(separator: "/").map(String.init), method: method, body: body, contentType: contentType)
    }

    private func request<T: Decodable>(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json",
        queryItems: [URLQueryItem] = []
    ) async throws -> T {
        let data = try await requestData(pathSegments, method: method, body: body, contentType: contentType, queryItems: queryItems)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIClientError.invalidResponse("Backend response did not match the expected shape.")
        }
    }

    private func requestData(
        _ pathSegments: [String],
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json",
        queryItems: [URLQueryItem] = []
    ) async throws -> Data {
        let url = try url(pathSegments: pathSegments, queryItems: queryItems)
        var request = URLRequest(url: url)
        request.httpMethod = method
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 {
                throw APIClientError.unauthorized
            }
            if let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: data),
               let message = apiError.message ?? apiError.error {
                throw APIClientError.server(message)
            }
            throw APIClientError.server("Backend returned HTTP \(http.statusCode).")
        }
        return data
    }

    func url(pathSegments: [String], queryItems: [URLQueryItem] = []) throws -> URL {
        var pathAllowed = CharacterSet.urlPathAllowed
        pathAllowed.remove(charactersIn: "/")
        guard var components = URLComponents(url: serverBaseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let encodedSegments = pathSegments.map { segment in
            segment.addingPercentEncoding(withAllowedCharacters: pathAllowed) ?? segment
        }
        let fullPath = ([basePath].filter { !$0.isEmpty } + encodedSegments).joined(separator: "/")
        components.percentEncodedPath = fullPath.isEmpty ? "" : "/\(fullPath)"
        if !queryItems.isEmpty {
            components.queryItems = queryItems
            // `URLComponents` escapes the rest of the query delimiters but leaves a
            // literal `+` alone, and the backend's query parser reads `+` as a
            // space — so a search query like "a + b" would arrive as "a   b".
            // Percent-encoding never emits `+`, so every `+` still present here
            // came from caller text and has to be escaped.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacing("+", with: "%2B")
        }
        guard let url = components.url else {
            throw URLError(.badURL)
        }
        return url
    }
}

/// Holds a caller-supplied result limit inside the range the backend accepts, so
/// a computed or stale limit degrades to a bounded read instead of a 400.
private func clampedLimit(_ limit: Int, upperBound: Int) -> Int {
    min(max(limit, 1), upperBound)
}

private func multipartBody(
    boundary: String,
    fieldName: String,
    filename: String,
    contentType: String,
    data: Data
) -> Data {
    var body = Data()
    body.appendString("--\(boundary)\r\n")
    body.appendString("Content-Disposition: form-data; name=\"\(escapeMultipartValue(fieldName))\"; filename=\"\(escapeMultipartValue(filename))\"\r\n")
    body.appendString("Content-Type: \(contentType)\r\n\r\n")
    body.append(data)
    body.appendString("\r\n--\(boundary)--\r\n")
    return body
}

private func escapeMultipartValue(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\r", with: "")
        .replacingOccurrences(of: "\n", with: "")
}

private extension Data {
    mutating func appendString(_ value: String) {
        append(Data(value.utf8))
    }
}
