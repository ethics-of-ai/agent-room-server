import Foundation

public struct BackendReleaseCompatibility: Codable, Hashable, Sendable {
    public var backendVersion: String
    public var apiVersion: String
    public var minimumSupportedClientApiVersion: String
    public var compatibleClients: CompatibleClients

    public init(
        backendVersion: String,
        apiVersion: String,
        minimumSupportedClientApiVersion: String,
        compatibleClients: CompatibleClients
    ) {
        self.backendVersion = backendVersion
        self.apiVersion = apiVersion
        self.minimumSupportedClientApiVersion = minimumSupportedClientApiVersion
        self.compatibleClients = compatibleClients
    }

    public struct CompatibleClients: Codable, Hashable, Sendable {
        public var macos: Client
        public var visionos: Client

        public init(macos: Client, visionos: Client) {
            self.macos = macos
            self.visionos = visionos
        }
    }

    public struct Client: Codable, Hashable, Sendable {
        public var minimumVersion: String

        public init(minimumVersion: String) {
            self.minimumVersion = minimumVersion
        }
    }
}

public struct HealthResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var uptimeSeconds: Int
    public var runnerKind: String
    public var mode: String
    public var release: BackendReleaseCompatibility?

    public init(
        ok: Bool,
        uptimeSeconds: Int,
        runnerKind: String,
        mode: String,
        release: BackendReleaseCompatibility? = nil
    ) {
        self.ok = ok
        self.uptimeSeconds = uptimeSeconds
        self.runnerKind = runnerKind
        self.mode = mode
        self.release = release
    }
}

public struct APIErrorResponse: Codable, Hashable {
    public var error: String?
    public var message: String?

    public init(error: String? = nil, message: String? = nil) {
        self.error = error
        self.message = message
    }
}

public struct AuthCheckResponse: Codable, Hashable {
    public var authRequired: Bool
    public var authenticated: Bool

    public init(authRequired: Bool, authenticated: Bool) {
        self.authRequired = authRequired
        self.authenticated = authenticated
    }
}

/// One entry of `/api/config`'s additive `settings` metadata block: a managed
/// setting's running value plus where it came from.
///
/// Tier 3 — `AUTH_TOKEN`, executable paths, `TERMINAL_SHELL`, host/port, the
/// storage directories — has no entry here *by construction* on the backend,
/// which is what keeps an ungated `/api/config` non-secret. See
/// `docs/api/API.md` and `docs/safety/TRUST_AND_SAFETY.md`.
public struct PublicManagedSetting: Codable, Hashable {
    /// The value this backend process is running with; absent when unset.
    public var value: JSONValue?
    /// `env` | `file` | `default`. An environment variable wins and *locks* the
    /// key, so a settings-file value for it is inert rather than pending.
    public var source: String
    /// `1` preference, `2` trust posture.
    public var tier: Int
    /// `string` | `boolean` | `number`: the shape of this setting's value, so a
    /// client with no compiled-in presentation for the key can still choose a
    /// control for it. Reported even when `value` is absent, which is exactly the
    /// case a client could infer no shape from.
    ///
    /// Optional because a backend that predates it decodes as `nil` — such a
    /// backend also registers no runner this app was not built with, so there is
    /// nothing generic to draw.
    public var valueKind: String?
    /// The values this setting's declaration accepts, when it bounds them.
    /// Absent for an open value (a model id, a timeout), where the backend's
    /// schema stays the authority.
    ///
    /// A client must not offer free text for a key that has these: writing
    /// something outside them would look like a valid edit and come back a `400`.
    public var options: [JSONValue]?
    /// Whether `PATCH /api/config` would accept this key right now — it folds in
    /// both the environment lock and the tier-2 remote-admin gate. The macOS app
    /// writes the file directly, so it reads `source` instead.
    public var editable: Bool
    public var requiresRestart: Bool
    /// The value a backend restart would produce, present only when the file on
    /// disk no longer agrees with the running snapshot.
    ///
    /// `.some(.null)` is meaningful and distinct from `.none`: it means a restart
    /// would leave the key *unset*, where `.none` means nothing is pending at all.
    public var pendingValue: JSONValue?

    // Spelled out because the custom coding below suppresses synthesis.
    private enum CodingKeys: String, CodingKey {
        case value, source, tier, valueKind, options, editable, requiresRestart, pendingValue
    }

    public init(
        value: JSONValue? = nil,
        source: String,
        tier: Int,
        valueKind: String? = nil,
        options: [JSONValue]? = nil,
        editable: Bool,
        requiresRestart: Bool = true,
        pendingValue: JSONValue? = nil
    ) {
        self.value = value
        self.source = source
        self.tier = tier
        self.valueKind = valueKind
        self.options = options
        self.editable = editable
        self.requiresRestart = requiresRestart
        self.pendingValue = pendingValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = try container.decodeIfPresent(JSONValue.self, forKey: .value)
        source = try container.decode(String.self, forKey: .source)
        tier = try container.decode(Int.self, forKey: .tier)
        valueKind = try container.decodeIfPresent(String.self, forKey: .valueKind)
        options = try container.decodeIfPresent([JSONValue].self, forKey: .options)
        editable = try container.decode(Bool.self, forKey: .editable)
        requiresRestart = try container.decodeIfPresent(Bool.self, forKey: .requiresRestart) ?? true
        // Decoded by presence, not with `decodeIfPresent`: that collapses an
        // explicit JSON null into `nil`, erasing the difference between "nothing
        // is pending" and "a restart would unset this key".
        pendingValue = container.contains(.pendingValue)
            ? try container.decode(JSONValue.self, forKey: .pendingValue)
            : nil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(value, forKey: .value)
        try container.encode(source, forKey: .source)
        try container.encode(tier, forKey: .tier)
        try container.encodeIfPresent(valueKind, forKey: .valueKind)
        try container.encodeIfPresent(options, forKey: .options)
        try container.encode(editable, forKey: .editable)
        try container.encode(requiresRestart, forKey: .requiresRestart)
        if let pendingValue {
            try container.encode(pendingValue, forKey: .pendingValue)
        }
    }
}

/// Safe client-renderable subset of the backend's `/api/config` response. Only the
/// fields the visionOS client renders are decoded; the backend sends more (release
/// compatibility, Codex/Claude posture) and any extra keys are ignored. `terminalEnabled`
/// is optional so an older backend that predates the field decodes as `nil` (treated as off).
public struct PublicServiceConfig: Codable, Hashable {
    public var runnerKind: String
    /// Which `coding_*` event contract the backend speaks. Optional so a
    /// backend that predates the field decodes as `nil`, which the client reads
    /// as version 1 (legacy per-runner metadata, no canonical activity).
    public var codingEventContractVersion: Int?
    public var requireAuth: Bool
    public var terminalEnabled: Bool?
    public var sceneEngineEnabled: Bool?
    /// Managed-settings metadata keyed by setting name. Optional so a backend
    /// that predates the shared settings store still decodes.
    public var settings: [String: PublicManagedSetting]?
    /// The Mac-side master switch for remote tier-2 edits (`REMOTE_SETTINGS_ADMIN`).
    public var remoteSettingsAdmin: Bool?

    /// The lowest coding-event contract this client can render. The backend
    /// dual-emits the legacy metadata blocks until its own advertised version
    /// passes this, so a mismatch is informational rather than fatal.
    public static let minimumCodingEventContractVersion = 1

    public var codingEventContract: Int {
        codingEventContractVersion ?? 1
    }

    public init(
        runnerKind: String,
        codingEventContractVersion: Int? = nil,
        requireAuth: Bool,
        terminalEnabled: Bool?,
        sceneEngineEnabled: Bool? = nil,
        settings: [String: PublicManagedSetting]? = nil,
        remoteSettingsAdmin: Bool? = nil
    ) {
        self.runnerKind = runnerKind
        self.codingEventContractVersion = codingEventContractVersion
        self.requireAuth = requireAuth
        self.terminalEnabled = terminalEnabled
        self.sceneEngineEnabled = sceneEngineEnabled
        self.settings = settings
        self.remoteSettingsAdmin = remoteSettingsAdmin
    }
}

public struct RegisterWorkspaceRequest: Codable, Hashable {
    public var path: String
    public var kind: String

    public init(path: String, kind: String = "user_selected") {
        self.path = path
        self.kind = kind
    }
}

public struct RegisterWorkspaceResponse: Codable, Hashable {
    public var workspace: LocalWorkspace

    public init(workspace: LocalWorkspace) {
        self.workspace = workspace
    }
}

public struct SwitchWorkspaceBranchRequest: Codable, Hashable {
    public var branch: String

    public init(branch: String) {
        self.branch = branch
    }
}

public struct WorkspaceFileWriteRequest: Codable, Hashable {
    public var path: String
    public var content: String
    public var baseModifiedAt: String?

    public init(path: String, content: String, baseModifiedAt: String? = nil) {
        self.path = path
        self.content = content
        self.baseModifiedAt = baseModifiedAt
    }
}

public struct WorkspaceBranchSwitchResponse: Codable, Hashable {
    public var workspace: LocalWorkspace
    public var previousBranch: String?
    public var branch: String
    public var changed: Bool

    public init(
        workspace: LocalWorkspace,
        previousBranch: String? = nil,
        branch: String,
        changed: Bool
    ) {
        self.workspace = workspace
        self.previousBranch = previousBranch
        self.branch = branch
        self.changed = changed
    }
}

/// The fixed set of mutating git operations the backend exposes. Nothing here
/// rewrites history: there is no amend, reset, rebase, or forced push, and pull
/// is fast-forward only. See docs/safety/TRUST_AND_SAFETY.md.
public enum WorkspaceGitOperation: String, Codable, Hashable, Sendable {
    case stage
    case unstage
    case discard
    case commit
    case fetch
    case pull
    case push
    case createBranch = "create_branch"
    case switchBranch = "switch_branch"
}

public struct WorkspaceGitPathsRequest: Codable, Hashable {
    public var paths: [String]?
    /// Act on every changed path git reports instead of a caller-supplied list.
    public var all: Bool?

    public init(paths: [String]? = nil, all: Bool? = nil) {
        self.paths = paths
        self.all = all
    }
}

public struct WorkspaceGitCommitRequest: Codable, Hashable {
    public var message: String
    public var stageAll: Bool?

    public init(message: String, stageAll: Bool? = nil) {
        self.message = message
        self.stageAll = stageAll
    }
}

public struct WorkspaceGitPushRequest: Codable, Hashable {
    /// Publish a branch that has no upstream yet (`push --set-upstream`).
    public var setUpstream: Bool?

    public init(setUpstream: Bool? = nil) {
        self.setUpstream = setUpstream
    }
}

public struct CreateWorkspaceBranchRequest: Codable, Hashable {
    public var branch: String

    public init(branch: String) {
        self.branch = branch
    }
}

/// One response shape for every git operation: the refreshed workspace and Git
/// status, so a client re-renders its whole source-control surface from a single
/// reply instead of chasing the mutation with two more reads.
public struct WorkspaceGitOperationResult: Codable, Hashable {
    public var workspaceId: String
    public var operation: WorkspaceGitOperation
    public var workspace: LocalWorkspace
    public var status: LocalWorkspaceGitStatus
    /// Paths the operation acted on, after filtering.
    public var paths: [String]?
    /// Paths a stage-all enumeration refused because a segment is secret-named
    /// or generated. Surfaced so the UI can say what it skipped.
    public var skippedPaths: [String]?
    public var commit: String?
    public var commitSubject: String?
    public var branch: String?
    public var previousBranch: String?
    public var remote: String?

    public init(
        workspaceId: String,
        operation: WorkspaceGitOperation,
        workspace: LocalWorkspace,
        status: LocalWorkspaceGitStatus,
        paths: [String]? = nil,
        skippedPaths: [String]? = nil,
        commit: String? = nil,
        commitSubject: String? = nil,
        branch: String? = nil,
        previousBranch: String? = nil,
        remote: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.operation = operation
        self.workspace = workspace
        self.status = status
        self.paths = paths
        self.skippedPaths = skippedPaths
        self.commit = commit
        self.commitSubject = commitSubject
        self.branch = branch
        self.previousBranch = previousBranch
        self.remote = remote
    }
}

public struct LocalWorkspaceRegistrySnapshot: Codable, Hashable {
    public var defaultWorkspaceRoot: String
    public var workspaces: [LocalWorkspace]

    public init(defaultWorkspaceRoot: String, workspaces: [LocalWorkspace]) {
        self.defaultWorkspaceRoot = defaultWorkspaceRoot
        self.workspaces = workspaces
    }
}

public struct LocalWorkspace: Codable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var path: String
    public var kind: String
    public var trustedAt: String
    public var lastOpenedAt: String
    public var git: LocalWorkspaceGitSnapshot

    public init(
        id: String,
        name: String,
        path: String,
        kind: String,
        trustedAt: String,
        lastOpenedAt: String,
        git: LocalWorkspaceGitSnapshot
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.kind = kind
        self.trustedAt = trustedAt
        self.lastOpenedAt = lastOpenedAt
        self.git = git
    }
}

public struct LocalWorkspaceGitSnapshot: Codable, Hashable {
    public var isRepository: Bool
    public var branch: String?
    public var remote: String?
    /// True when any Git remote is configured, even when it is not named `origin`.
    public var hasRemote: Bool?
    public var branches: [LocalWorkspaceGitBranch]?
    public var hasUncommittedChanges: Bool?
    /// The current branch's upstream, e.g. `origin/main`, when it tracks one.
    public var upstream: String?
    /// True when the branch tracks an upstream that no longer exists on the remote.
    public var upstreamGone: Bool?
    /// Commits ahead of / behind the upstream **as of the last fetch**, which is
    /// why the client offers a Fetch control to refresh them.
    public var ahead: Int?
    public var behind: Int?

    public init(
        isRepository: Bool,
        branch: String?,
        remote: String?,
        hasRemote: Bool? = nil,
        branches: [LocalWorkspaceGitBranch]? = nil,
        hasUncommittedChanges: Bool? = nil,
        upstream: String? = nil,
        upstreamGone: Bool? = nil,
        ahead: Int? = nil,
        behind: Int? = nil
    ) {
        self.isRepository = isRepository
        self.branch = branch
        self.remote = remote
        self.hasRemote = hasRemote
        self.branches = branches
        self.hasUncommittedChanges = hasUncommittedChanges
        self.upstream = upstream
        self.upstreamGone = upstreamGone
        self.ahead = ahead
        self.behind = behind
    }

    /// True when the branch has no upstream yet, so pushing it means publishing it.
    public var needsPublish: Bool {
        isRepository && branch != nil && upstream == nil
    }
}

public struct LocalWorkspaceGitBranch: Codable, Hashable, Identifiable {
    public var name: String
    public var current: Bool
    public var upstream: String?
    public var upstreamGone: Bool?
    public var ahead: Int?
    public var behind: Int?

    public var id: String { name }

    public init(
        name: String,
        current: Bool,
        upstream: String? = nil,
        upstreamGone: Bool? = nil,
        ahead: Int? = nil,
        behind: Int? = nil
    ) {
        self.name = name
        self.current = current
        self.upstream = upstream
        self.upstreamGone = upstreamGone
        self.ahead = ahead
        self.behind = behind
    }
}

public struct LocalWorkspaceGitStatus: Codable, Hashable {
    public var workspaceId: String
    public var isRepository: Bool
    public var branch: String?
    public var clean: Bool
    public var counts: LocalWorkspaceGitStatusCounts
    public var files: [LocalWorkspaceGitChangedFile]
    public var truncated: Bool
    public var refreshedAt: String

    public init(
        workspaceId: String,
        isRepository: Bool,
        branch: String? = nil,
        clean: Bool,
        counts: LocalWorkspaceGitStatusCounts,
        files: [LocalWorkspaceGitChangedFile],
        truncated: Bool,
        refreshedAt: String
    ) {
        self.workspaceId = workspaceId
        self.isRepository = isRepository
        self.branch = branch
        self.clean = clean
        self.counts = counts
        self.files = files
        self.truncated = truncated
        self.refreshedAt = refreshedAt
    }
}

public struct LocalWorkspaceGitStatusCounts: Codable, Hashable {
    public var total: Int
    public var staged: Int
    public var unstaged: Int
    public var untracked: Int
    public var conflicts: Int

    public init(total: Int, staged: Int, unstaged: Int, untracked: Int, conflicts: Int) {
        self.total = total
        self.staged = staged
        self.unstaged = unstaged
        self.untracked = untracked
        self.conflicts = conflicts
    }
}

public struct LocalWorkspaceGitChangedFile: Codable, Hashable, Identifiable {
    public var path: String
    public var oldPath: String?
    public var status: String
    public var staged: Bool
    public var unstaged: Bool
    public var additions: Int?
    public var deletions: Int?

    public var id: String { "\(path):\(oldPath ?? ""):\(status)" }

    public init(
        path: String,
        oldPath: String? = nil,
        status: String,
        staged: Bool,
        unstaged: Bool,
        additions: Int? = nil,
        deletions: Int? = nil
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.staged = staged
        self.unstaged = unstaged
        self.additions = additions
        self.deletions = deletions
    }
}

public struct WorkspaceTreeSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var entries: [WorkspaceTreeEntry]

    public init(workspaceId: String, path: String, entries: [WorkspaceTreeEntry]) {
        self.workspaceId = workspaceId
        self.path = path
        self.entries = entries
    }
}

public struct WorkspaceTreeEntry: Codable, Hashable, Identifiable {
    public var type: String
    public var name: String
    public var path: String
    public var sizeBytes: Int?
    public var modifiedAt: String?
    public var previewable: Bool?
    public var children: [WorkspaceTreeEntry]?

    public var id: String { path }
    public var isDirectory: Bool { type == "directory" }
    public var isPreviewableFile: Bool { !isDirectory && previewable == true }

    public init(
        type: String,
        name: String,
        path: String,
        sizeBytes: Int? = nil,
        modifiedAt: String? = nil,
        previewable: Bool? = nil,
        children: [WorkspaceTreeEntry]? = nil
    ) {
        self.type = type
        self.name = name
        self.path = path
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.previewable = previewable
        self.children = children
    }
}

public struct WorkspaceFilePreview: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var name: String
    public var sizeBytes: Int
    public var modifiedAt: String
    public var encoding: String
    public var content: String
    public var truncated: Bool
    public var previewable: Bool

    public init(
        workspaceId: String,
        path: String,
        name: String,
        sizeBytes: Int,
        modifiedAt: String,
        encoding: String,
        content: String,
        truncated: Bool,
        previewable: Bool
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.name = name
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.encoding = encoding
        self.content = content
        self.truncated = truncated
        self.previewable = previewable
    }
}

/// The git HEAD version of a workspace file, used to diff the working tree
/// against the committed baseline. A file not yet in HEAD and a non-repository
/// workspace are ordinary data states (`existsInHead` / `isRepository` false),
/// not errors; `content` is present only for an in-cap UTF-8 blob.
public struct WorkspaceGitFileBaseline: Codable, Hashable {
    public var workspaceId: String
    public var path: String
    public var ref: String
    public var isRepository: Bool
    public var existsInHead: Bool
    public var sizeBytes: Int?
    public var encoding: String?
    public var content: String?
    public var truncated: Bool?

    public var hasUsableContent: Bool {
        isRepository && existsInHead && truncated != true && content != nil
    }

    public init(
        workspaceId: String,
        path: String,
        ref: String,
        isRepository: Bool,
        existsInHead: Bool,
        sizeBytes: Int? = nil,
        encoding: String? = nil,
        content: String? = nil,
        truncated: Bool? = nil
    ) {
        self.workspaceId = workspaceId
        self.path = path
        self.ref = ref
        self.isRepository = isRepository
        self.existsInHead = existsInHead
        self.sizeBytes = sizeBytes
        self.encoding = encoding
        self.content = content
        self.truncated = truncated
    }
}

/// One file in the bounded workspace file index that backs quick-open and the
/// `@` mention picker. Carries path metadata only — never file content.
/// `previewable` means the same thing as the tree read's flag: a non-secret,
/// text-openable file within the backend write cap, so the editor can open and
/// save it.
public struct WorkspaceFileIndexEntry: Codable, Hashable, Identifiable {
    public var path: String
    public var name: String
    public var previewable: Bool

    public var id: String { path }

    public init(path: String, name: String, previewable: Bool) {
        self.path = path
        self.name = name
        self.previewable = previewable
    }
}

/// A ranked, bounded slice of a registered workspace's file index. `query`
/// echoes the trimmed query the ranking used, and is empty when the listing was
/// unfiltered. `truncated` is true when the enumeration hit its path cap or when
/// more ranked matches existed than the requested limit.
public struct WorkspaceFileIndexSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var query: String
    public var files: [WorkspaceFileIndexEntry]
    public var truncated: Bool

    public init(
        workspaceId: String,
        query: String,
        files: [WorkspaceFileIndexEntry],
        truncated: Bool
    ) {
        self.workspaceId = workspaceId
        self.query = query
        self.files = files
        self.truncated = truncated
    }
}

/// One literal-substring hit inside a workspace file. `line`, `column`, and
/// `previewColumn` are all 1-indexed (Monaco convention), and `column` and
/// `length` are UTF-16 code-unit offsets. Navigate with `line`/`column` against
/// the file itself; highlight with `previewColumn`/`length` against `preview`,
/// which is the matched line capped at 200 characters centred on the match, so
/// the two column values differ whenever the preview window was shifted.
public struct WorkspaceSearchMatch: Codable, Hashable, Identifiable {
    public var line: Int
    public var column: Int
    public var length: Int
    public var preview: String
    public var previewColumn: Int

    public var id: String { "\(line):\(column)" }

    public init(line: Int, column: Int, length: Int, preview: String, previewColumn: Int) {
        self.line = line
        self.column = column
        self.length = length
        self.preview = preview
        self.previewColumn = previewColumn
    }
}

/// Every returned hit in one file. `truncated` is per-file: this file had more
/// matches than were returned, because of the per-file cap, the run's total
/// match cap, or the per-file byte cap.
public struct WorkspaceSearchFileMatches: Codable, Hashable, Identifiable {
    public var path: String
    public var matches: [WorkspaceSearchMatch]
    public var truncated: Bool

    public var id: String { path }

    public init(path: String, matches: [WorkspaceSearchMatch], truncated: Bool) {
        self.path = path
        self.matches = matches
        self.truncated = truncated
    }
}

/// Result of a bounded, read-only literal-substring search over a registered
/// workspace. `filesScanned` counts files actually opened and read. The
/// top-level `truncated` is a *global* bound — the index cap, the file-scan cap,
/// the total-match cap, or the time budget cut the run short — and is distinct
/// from each file's own `truncated`.
public struct WorkspaceSearchSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var query: String
    public var files: [WorkspaceSearchFileMatches]
    public var totalMatches: Int
    public var filesScanned: Int
    public var truncated: Bool

    public init(
        workspaceId: String,
        query: String,
        files: [WorkspaceSearchFileMatches],
        totalMatches: Int,
        filesScanned: Int,
        truncated: Bool
    ) {
        self.workspaceId = workspaceId
        self.query = query
        self.files = files
        self.totalMatches = totalMatches
        self.filesScanned = filesScanned
        self.truncated = truncated
    }
}

/// One user-invocable skill discovered in a registered workspace's committed
/// skill directories. `invocation` is the runner-appropriate composer token
/// (`/name` for Claude Code slash commands, `$name` for Codex skill mentions),
/// computed backend-side so clients never hardcode per-runner syntax.
public struct WorkspaceSkill: Codable, Hashable, Identifiable {
    public var name: String
    public var description: String?
    public var invocation: String
    public var source: String

    public var id: String { "\(source)/\(name)" }

    public init(name: String, description: String? = nil, invocation: String, source: String) {
        self.name = name
        self.description = description
        self.invocation = invocation
        self.source = source
    }
}

/// The skills a runner kind would natively load from a registered workspace.
/// `available` is `false` when sessions of that kind would not load them (the
/// Claude Code workspace-settings gate); the list is empty in that state.
public struct WorkspaceSkillsSnapshot: Codable, Hashable {
    public var workspaceId: String
    public var runnerKind: String
    public var available: Bool
    public var skills: [WorkspaceSkill]

    public init(workspaceId: String, runnerKind: String, available: Bool, skills: [WorkspaceSkill]) {
        self.workspaceId = workspaceId
        self.runnerKind = runnerKind
        self.available = available
        self.skills = skills
    }
}

public struct AgentSessionListResponse: Codable, Hashable {
    public var sessions: [AgentSession]

    public init(sessions: [AgentSession]) {
        self.sessions = sessions
    }
}

public struct AgentSessionResponse: Codable, Hashable {
    public var session: AgentSession

    public init(session: AgentSession) {
        self.session = session
    }
}

public struct AgentSessionTurnResponse: Codable, Hashable {
    public var turn: AgentSessionTurn

    public init(turn: AgentSessionTurn) {
        self.turn = turn
    }
}

public struct AgentSessionMessageListResponse: Codable, Hashable {
    public var messages: [AgentSessionMessage]

    public init(messages: [AgentSessionMessage]) {
        self.messages = messages
    }
}

public struct AgentSessionAttachmentResponse: Codable, Hashable {
    public var attachment: AgentSessionAttachment

    public init(attachment: AgentSessionAttachment) {
        self.attachment = attachment
    }
}

public struct AgentSession: Codable, Hashable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var workspacePath: String
    public var gitBranch: String?
    public var runnerKind: String
    public var settings: CodingAgentTurnSettings?
    public var modelContextWindowTokens: Int?
    public var contextWindowUsedTokens: Int?
    public var title: String?
    public var status: String
    public var activeTurnId: String?
    public var lastMessage: String?
    public var error: String?
    public var turnCount: Int
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String,
        workspaceId: String,
        workspacePath: String,
        gitBranch: String? = nil,
        runnerKind: String,
        settings: CodingAgentTurnSettings? = nil,
        modelContextWindowTokens: Int? = nil,
        contextWindowUsedTokens: Int? = nil,
        title: String?,
        status: String,
        activeTurnId: String?,
        lastMessage: String?,
        error: String?,
        turnCount: Int,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.workspacePath = workspacePath
        self.gitBranch = gitBranch
        self.runnerKind = runnerKind
        self.settings = settings
        self.modelContextWindowTokens = modelContextWindowTokens
        self.contextWindowUsedTokens = contextWindowUsedTokens
        self.title = title
        self.status = status
        self.activeTurnId = activeTurnId
        self.lastMessage = lastMessage
        self.error = error
        self.turnCount = turnCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct AgentSessionTurn: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var status: String
    public var startedAt: String
    public var completedAt: String?
    public var lastMessage: String?
    public var error: String?
    public var inputTokens: Int
    public var outputTokens: Int
    public var totalTokens: Int
    public var modelContextWindowTokens: Int?

    public init(
        id: String,
        sessionId: String,
        status: String,
        startedAt: String,
        completedAt: String?,
        lastMessage: String?,
        error: String?,
        inputTokens: Int,
        outputTokens: Int,
        totalTokens: Int,
        modelContextWindowTokens: Int? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.lastMessage = lastMessage
        self.error = error
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.modelContextWindowTokens = modelContextWindowTokens
    }
}

public struct AgentSessionMessageContextAttachment: Codable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var sourceName: String
    public var contentType: String
    public var sizeBytes: Int

    public init(
        id: String,
        kind: String,
        sourceName: String,
        contentType: String,
        sizeBytes: Int
    ) {
        self.id = id
        self.kind = kind
        self.sourceName = sourceName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }
}

public struct AgentSessionMessageContext: Codable, Hashable {
    public var paths: [String]?
    public var attachments: [AgentSessionMessageContextAttachment]?
    /// Set on the user message the backend records when a person answers a
    /// clarifying-question batch: the batch it answers. A client can caption
    /// that message as the answer it is rather than as a typed turn.
    public var questionRequestId: String?

    public init(
        paths: [String]? = nil,
        attachments: [AgentSessionMessageContextAttachment]? = nil,
        questionRequestId: String? = nil
    ) {
        self.paths = paths
        self.attachments = attachments
        self.questionRequestId = questionRequestId
    }
}

public struct AgentSessionMessage: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var turnId: String?
    public var role: String
    public var content: String
    public var context: AgentSessionMessageContext?
    public var status: String
    public var at: String

    public init(
        id: String,
        sessionId: String,
        turnId: String?,
        role: String,
        content: String,
        context: AgentSessionMessageContext?,
        status: String,
        at: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.role = role
        self.content = content
        self.context = context
        self.status = status
        self.at = at
    }

    public init(
        id: String,
        sessionId: String,
        turnId: String?,
        role: String,
        content: String,
        status: String,
        at: String
    ) {
        self.init(
            id: id,
            sessionId: sessionId,
            turnId: turnId,
            role: role,
            content: content,
            context: nil,
            status: status,
            at: at
        )
    }
}

public struct AgentSessionAttachment: Codable, Hashable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var sessionId: String
    public var kind: String
    public var sourceName: String
    public var contentType: String
    public var sizeBytes: Int
    public var sha256: String
    public var createdAt: String

    public init(
        id: String,
        workspaceId: String,
        sessionId: String,
        kind: String,
        sourceName: String,
        contentType: String,
        sizeBytes: Int,
        sha256: String,
        createdAt: String
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.sessionId = sessionId
        self.kind = kind
        self.sourceName = sourceName
        self.contentType = contentType
        self.sizeBytes = sizeBytes
        self.sha256 = sha256
        self.createdAt = createdAt
    }
}

public struct CreateAgentSessionRequest: Codable, Hashable {
    public var workspaceId: String
    /// Optional runner kind. When `nil` the field is omitted from the request so
    /// the backend applies its configured default (`RUNNER_KIND`).
    public var runnerKind: String?
    public var gitBranch: String?
    public var settings: CodingAgentTurnSettings?
    public var title: String?

    public init(
        workspaceId: String,
        runnerKind: String? = nil,
        gitBranch: String? = nil,
        settings: CodingAgentTurnSettings? = nil,
        title: String?
    ) {
        self.workspaceId = workspaceId
        self.runnerKind = runnerKind
        self.gitBranch = gitBranch
        self.settings = settings
        self.title = title
    }
}

/// Answers one outstanding permission request. The body carries only an option
/// the agent itself offered; the request it belongs to is in the path, and the
/// backend refuses an option that was not among the ones it is holding.
public struct AnswerPermissionRequest: Codable, Hashable {
    public var optionId: String

    public init(optionId: String) {
        self.optionId = optionId
    }
}

/// Answers one outstanding clarifying-question batch: per answered set, the
/// option ids chosen from the ones the agent offered and the person's own free
/// text where the set invited it. A set the body omits stays unanswered. The
/// backend refuses a set or option the agent did not offer, a second choice on
/// a single-select set, and free text on a set that accepts none.
public struct AnswerQuestionRequest: Codable, Hashable {
    public var answers: [CodingQuestionAnswer]

    public init(answers: [CodingQuestionAnswer]) {
        self.answers = answers
    }
}

/// One clarifying-question batch a session still holds open, as served by
/// `GET /api/agent-sessions/:id/questions` for a client that joined after the
/// event replay rolled over. The sets are exactly what the request event carried.
public struct OutstandingQuestionRequest: Codable, Hashable, Identifiable {
    public var requestId: String
    public var turnId: String
    public var questionSets: [CodingQuestionSet]

    public var id: String { requestId }

    public init(requestId: String, turnId: String, questionSets: [CodingQuestionSet]) {
        self.requestId = requestId
        self.turnId = turnId
        self.questionSets = questionSets
    }
}

public struct OutstandingQuestionsResponse: Codable, Hashable {
    public var questions: [OutstandingQuestionRequest]

    public init(questions: [OutstandingQuestionRequest]) {
        self.questions = questions
    }
}

public struct SendAgentTurnRequest: Codable, Hashable {
    public var message: String
    public var context: AgentTurnContext?
    public var settings: CodingAgentTurnSettings?

    public init(
        message: String,
        context: AgentTurnContext?,
        settings: CodingAgentTurnSettings? = nil
    ) {
        self.message = message
        self.context = context
        self.settings = settings
    }
}

public struct AgentTurnContext: Codable, Hashable {
    public var paths: [String]?
    public var attachments: [String]?

    public init(paths: [String]? = nil, attachments: [String]? = nil) {
        self.paths = paths
        self.attachments = attachments
    }
}

public struct AgentBridgeMetrics: Codable, Hashable {
    public var totalSessions: Int
    public var runningSessions: Int
    public var completedTurns: Int
    public var failedTurns: Int
    public var cancelledTurns: Int
    public var inputTokens: Int
    public var outputTokens: Int
    public var totalTokens: Int

    public init(
        totalSessions: Int,
        runningSessions: Int,
        completedTurns: Int,
        failedTurns: Int,
        cancelledTurns: Int,
        inputTokens: Int,
        outputTokens: Int,
        totalTokens: Int
    ) {
        self.totalSessions = totalSessions
        self.runningSessions = runningSessions
        self.completedTurns = completedTurns
        self.failedTurns = failedTurns
        self.cancelledTurns = cancelledTurns
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }
}

public struct StatusSnapshot: Codable, Hashable {
    public var runnerKind: String
    public var uptimeSeconds: Int
    public var sessions: [AgentSession]
    public var activeSessionIds: [String]
    public var recentEvents: [AgentRoomEvent]
    public var metrics: AgentBridgeMetrics

    public init(
        runnerKind: String,
        uptimeSeconds: Int,
        sessions: [AgentSession],
        activeSessionIds: [String],
        recentEvents: [AgentRoomEvent],
        metrics: AgentBridgeMetrics
    ) {
        self.runnerKind = runnerKind
        self.uptimeSeconds = uptimeSeconds
        self.sessions = sessions
        self.activeSessionIds = activeSessionIds
        self.recentEvents = recentEvents
        self.metrics = metrics
    }
}

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self, !value.isEmpty else { return nil }
        return value
    }

    var intValue: Int? {
        guard let numberValue else { return nil }
        return Int(exactly: numberValue)
    }

    var numberValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    /// A stable, non-localized scalar representation for settings fields and
    /// diagnostic rows. Exact in-range integers omit the decimal point; every
    /// other finite JSON number stays a `Double` string without an unsafe cast.
    var numberText: String? {
        guard let numberValue else { return nil }
        return Int(exactly: numberValue).map(String.init) ?? String(numberValue)
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var displayString: String? {
        switch self {
        case .string(let value):
            return value.isEmpty ? nil : value
        case .number(let value):
            if value.rounded() == value {
                return String(Int(value))
            }
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return nil
        case .object, .array:
            guard let data = try? JSONEncoder().encode(self),
                  let text = String(data: data, encoding: .utf8) else {
                return nil
            }
            return text
        }
    }
}

public struct AgentRoomEvent: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var type: String
    public var at: String
    public var payload: JSONValue
    /// Typed view of `payload` for `coding_*` events, decoded once when the
    /// event is decoded. The previous computed property re-encoded and
    /// re-decoded the payload JSON on every access, which ran several times per
    /// event on the streaming hot path. Derived from `payload`; excluded from
    /// the wire encoding.
    public var codingPayload: CodingAgentEventPayload?

    private enum CodingKeys: String, CodingKey {
        case id, type, at, payload
    }

    public init(id: String, type: String, at: String, payload: JSONValue) {
        self.id = id
        self.type = type
        self.at = at
        self.payload = payload
        self.codingPayload = AgentRoomEvent.decodedCodingPayload(type: type, payload: payload)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        at = try container.decode(String.self, forKey: .at)
        payload = try container.decode(JSONValue.self, forKey: .payload)
        // Decode the typed payload straight from the wire JSON — no re-encode
        // round trip. Tolerant like the old computed property: a payload that
        // does not match the typed shape leaves `codingPayload` nil.
        codingPayload = type.hasPrefix("coding_")
            ? try? container.decode(CodingAgentEventPayload.self, forKey: .payload)
            : nil
    }

    private static func decodedCodingPayload(type: String, payload: JSONValue) -> CodingAgentEventPayload? {
        guard type.hasPrefix("coding_"),
              let data = try? JSONEncoder().encode(payload) else {
            return nil
        }
        return try? JSONDecoder().decode(CodingAgentEventPayload.self, from: data)
    }
}

public extension AgentRoomEvent {
    func stringValue(for key: String) -> String? {
        payload.objectValue?[key]?.stringValue
    }

    func nestedStringValue(_ keys: String...) -> String? {
        var current: JSONValue? = payload
        for key in keys {
            current = current?.objectValue?[key]
        }
        return current?.stringValue
    }

    func intValue(for key: String) -> Int? {
        payload.objectValue?[key]?.intValue
    }

    func nestedIntValue(_ keys: String...) -> Int? {
        var current: JSONValue? = payload
        for key in keys {
            current = current?.objectValue?[key]
        }
        return current?.intValue
    }

    var sessionId: String? {
        stringValue(for: "sessionId") ??
            nestedStringValue("session", "id")
    }

    var turnId: String? {
        stringValue(for: "turnId")
    }

    var message: String? {
        stringValue(for: "message") ?? nestedStringValue("session", "lastMessage")
    }

    var error: String? {
        stringValue(for: "error") ?? nestedStringValue("session", "error")
    }

    var workspacePath: String? {
        stringValue(for: "workspacePath") ??
            nestedStringValue("session", "workspacePath")
    }

    var totalTokens: Int? {
        intValue(for: "totalTokens") ?? nestedIntValue("session", "totalTokens")
    }

    var turnCount: Int? {
        intValue(for: "turnCount") ?? nestedIntValue("session", "turnCount")
    }
}

/// Lossless rather than a closed enum: a newer backend's event type must not
/// fail the whole payload decode and make the client drop an event it could
/// otherwise ignore gracefully. Unknown values round-trip as themselves.
///
/// Consequence at call sites: a `switch` over this is no longer exhaustive and
/// needs a `default`, which is the point — an unhandled future type is a
/// no-op, not a decode failure.
public struct CodingAgentEventType: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let sessionStarted = CodingAgentEventType(rawValue: "coding_session_started")
    public static let sessionRestored = CodingAgentEventType(rawValue: "coding_session_restored")
    public static let turnStarted = CodingAgentEventType(rawValue: "coding_turn_started")
    public static let tokenUsageUpdated = CodingAgentEventType(rawValue: "coding_token_usage_updated")
    public static let assistantMessageDelta = CodingAgentEventType(rawValue: "coding_assistant_message_delta")
    public static let planUpdated = CodingAgentEventType(rawValue: "coding_plan_updated")
    public static let diffUpdated = CodingAgentEventType(rawValue: "coding_diff_updated")
    public static let artifactStarted = CodingAgentEventType(rawValue: "coding_artifact_started")
    public static let artifactDelta = CodingAgentEventType(rawValue: "coding_artifact_delta")
    public static let artifactCompleted = CodingAgentEventType(rawValue: "coding_artifact_completed")
    public static let toolActivityStarted = CodingAgentEventType(rawValue: "coding_tool_activity_started")
    public static let toolActivityUpdated = CodingAgentEventType(rawValue: "coding_tool_activity_updated")
    public static let toolActivityCompleted = CodingAgentEventType(rawValue: "coding_tool_activity_completed")
    public static let permissionRequested = CodingAgentEventType(rawValue: "coding_permission_requested")
    public static let permissionResolved = CodingAgentEventType(rawValue: "coding_permission_resolved")
    public static let questionRequested = CodingAgentEventType(rawValue: "coding_question_requested")
    public static let questionResolved = CodingAgentEventType(rawValue: "coding_question_resolved")
    public static let turnCompleted = CodingAgentEventType(rawValue: "coding_turn_completed")
    public static let turnFailed = CodingAgentEventType(rawValue: "coding_turn_failed")
    public static let turnCancelled = CodingAgentEventType(rawValue: "coding_turn_cancelled")
}

/// The runner-agnostic reading of one activity. A client decides what an
/// activity *is* from this, never from the activity's native `kind` string —
/// that is what lets a runner the app has never heard of render correctly.
///
/// Lossless for the same reason as `CodingAgentEventType`: an unrecognized
/// canonical kind degrades to a generic tool row rather than failing a decode.
public struct CodingCanonicalActivityKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let sessionStarted = CodingCanonicalActivityKind(rawValue: "session_started")
    public static let turnStarted = CodingCanonicalActivityKind(rawValue: "turn_started")
    public static let planUpdated = CodingCanonicalActivityKind(rawValue: "plan_updated")
    public static let diffUpdated = CodingCanonicalActivityKind(rawValue: "diff_updated")
    public static let reasoning = CodingCanonicalActivityKind(rawValue: "reasoning")
    public static let toolStarted = CodingCanonicalActivityKind(rawValue: "tool_started")
    public static let toolOutput = CodingCanonicalActivityKind(rawValue: "tool_output")
    public static let toolCompleted = CodingCanonicalActivityKind(rawValue: "tool_completed")
    public static let permissionRequested = CodingCanonicalActivityKind(rawValue: "permission_requested")
    public static let permissionResolved = CodingCanonicalActivityKind(rawValue: "permission_resolved")
    public static let questionRequested = CodingCanonicalActivityKind(rawValue: "question_requested")
    public static let questionResolved = CodingCanonicalActivityKind(rawValue: "question_resolved")
}

/// Only the fields that can reach an activity block. Plan and diff payloads
/// carry their canonical detail on the event itself (`plan`, `files`) and never
/// arrive with an activity, so repeating those here would be dead weight.
public struct CodingCanonicalActivity: Codable, Hashable, Sendable {
    public var kind: CodingCanonicalActivityKind
    /// Stable per-tool-call id, the same value on start, output, and completion.
    public var toolId: String?
    public var delta: String?

    public init(kind: CodingCanonicalActivityKind, toolId: String? = nil, delta: String? = nil) {
        self.kind = kind
        self.toolId = toolId
        self.delta = delta
    }
}

/// Canonical correlation and display metadata carried by every `coding_*`
/// event. A client correlates and renders from these fields alone; `native`
/// holds bounded per-runner extras with no canonical home, and is absent
/// (with `nativeTruncated`) when it exceeded the backend's limits.
///
/// `posture` is the runner's own label/value pair — a Codex approval policy or
/// a Claude Code permission mode — deliberately not one reconciled enum.
public struct CodingRunnerMetadata: Codable, Hashable, Sendable {
    public struct Posture: Codable, Hashable, Sendable {
        public var label: String
        public var value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    public var nativeSessionId: String?
    public var nativeTurnId: String?
    public var nativeItemId: String?
    public var model: String?
    public var cwd: String?
    public var posture: Posture?
    public var sandbox: JSONValue?
    public var native: [String: JSONValue]?
    public var nativeTruncated: Bool?

    public init(
        nativeSessionId: String? = nil,
        nativeTurnId: String? = nil,
        nativeItemId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        posture: Posture? = nil,
        sandbox: JSONValue? = nil,
        native: [String: JSONValue]? = nil,
        nativeTruncated: Bool? = nil
    ) {
        self.nativeSessionId = nativeSessionId
        self.nativeTurnId = nativeTurnId
        self.nativeItemId = nativeItemId
        self.model = model
        self.cwd = cwd
        self.posture = posture
        self.sandbox = sandbox
        self.native = native
        self.nativeTruncated = nativeTruncated
    }
}

public struct CodingAgentCodexMetadata: Codable, Hashable, Sendable {
    public var method: String?
    public var threadId: String?
    public var turnId: String?
    public var itemId: String?
    public var model: String?
    public var cwd: String?
    public var approvalPolicy: String?
    public var sandbox: JSONValue?

    public init(
        method: String? = nil,
        threadId: String? = nil,
        turnId: String? = nil,
        itemId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        approvalPolicy: String? = nil,
        sandbox: JSONValue? = nil
    ) {
        self.method = method
        self.threadId = threadId
        self.turnId = turnId
        self.itemId = itemId
        self.model = model
        self.cwd = cwd
        self.approvalPolicy = approvalPolicy
        self.sandbox = sandbox
    }
}

public struct CodingAgentClaudeCodeMetadata: Codable, Hashable, Sendable {
    public var sessionId: String?
    public var messageUuid: String?
    public var parentToolUseId: String?
    public var model: String?
    public var cwd: String?
    public var permissionMode: String?

    public init(
        sessionId: String? = nil,
        messageUuid: String? = nil,
        parentToolUseId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        permissionMode: String? = nil
    ) {
        self.sessionId = sessionId
        self.messageUuid = messageUuid
        self.parentToolUseId = parentToolUseId
        self.model = model
        self.cwd = cwd
        self.permissionMode = permissionMode
    }
}

public struct CodingPlanStep: Codable, Hashable, Identifiable, Sendable {
    public var step: String
    public var status: String

    public var id: String {
        "\(step):\(status)"
    }

    public init(step: String, status: String) {
        self.step = step
        self.status = status
    }
}

public struct CodingDiffFile: Codable, Hashable, Identifiable, Sendable {
    public var path: String
    public var status: String
    public var additions: Int?
    public var deletions: Int?

    public var id: String {
        path
    }

    public init(path: String, status: String, additions: Int? = nil, deletions: Int? = nil) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

public struct CodingAgentActivity: Codable, Hashable, Identifiable, Sendable {
    /// The runner's own name for the activity. Display and diagnostics only —
    /// `canonical` is what a client should read to decide what this is.
    public var kind: String
    public var title: String
    public var description: String?
    public var content: [String: JSONValue]
    public var canonical: CodingCanonicalActivity?
    public var runner: CodingRunnerMetadata?
    /// Legacy per-runner blocks, dual-emitted by the backend while the coding
    /// event contract floor is below 2. Prefer `runner`.
    public var codex: CodingAgentCodexMetadata?
    public var claudeCode: CodingAgentClaudeCodeMetadata?

    /// Identity comes from the canonical tool id first, then the runner
    /// envelope's native item id — never from Codex metadata alone, which only
    /// one runner populates.
    public var id: String {
        canonicalToolId ?? runner?.nativeItemId ?? codex?.itemId ?? "\(kind):\(title)"
    }

    /// The stable per-tool-call id a client correlates a start, its output, and
    /// its completion by, in canonical-first order.
    public var canonicalToolId: String? {
        if let toolId = canonical?.toolId, !toolId.isEmpty { return toolId }
        return nil
    }

    public init(
        kind: String,
        title: String,
        description: String? = nil,
        content: [String: JSONValue],
        canonical: CodingCanonicalActivity? = nil,
        runner: CodingRunnerMetadata? = nil,
        codex: CodingAgentCodexMetadata? = nil,
        claudeCode: CodingAgentClaudeCodeMetadata? = nil
    ) {
        self.kind = kind
        self.title = title
        self.description = description
        self.content = content
        self.canonical = canonical
        self.runner = runner
        self.codex = codex
        self.claudeCode = claudeCode
    }
}

/// One answer a runner offered for a permission request.
///
/// A client may answer with one of these `optionId`s and nothing else — the
/// backend refuses an id the agent did not supply, so this list is the whole
/// vocabulary of an answer. `kind` is the agent's own classification
/// (`allow_once`, `reject_once`, …) and is deliberately an open string: an
/// unfamiliar one is rendered plainly rather than dropped, since dropping it
/// would hide the only answer the agent will accept.
public struct CodingPermissionOption: Codable, Hashable, Identifiable, Sendable {
    public var optionId: String
    public var name: String?
    public var kind: String?

    public var id: String { optionId }

    /// What to show on the button: the agent's own wording when it gave one.
    public var label: String { name ?? optionId }

    /// True for an option the agent classified as permitting the action. Used
    /// for emphasis only — the answer sent is always the option's own id.
    public var isAllow: Bool { kind?.hasPrefix("allow") ?? false }

    /// True only for an explicit rejection classification. An absent or newer
    /// kind is neither allow nor reject and must render neutrally.
    public var isReject: Bool { kind?.hasPrefix("reject") ?? false }

    public init(optionId: String, name: String? = nil, kind: String? = nil) {
        self.optionId = optionId
        self.name = name
        self.kind = kind
    }
}

/// Who decided a permission request, as reported on `coding_permission_resolved`.
/// Open-ended by construction: an unknown authority renders as itself rather
/// than being coerced into one of these.
public enum CodingPermissionAuthority {
    public static let human = "human"
    public static let policy = "policy"
    public static let timeout = "timeout"
}

/// One option the agent offered for a clarifying-question set. A client answers
/// with these `optionId`s and nothing else: the backend minted them and refuses
/// one the agent did not offer for that set.
public struct CodingQuestionOption: Codable, Hashable, Identifiable, Sendable {
    public var optionId: String
    public var label: String
    public var description: String?

    public var id: String { optionId }

    public init(optionId: String, label: String, description: String? = nil) {
        self.optionId = optionId
        self.label = label
        self.description = description
    }
}

/// How many options a set takes, as reported on `coding_question_requested`.
/// Open-ended by construction: an unknown value renders as single-select.
public enum CodingQuestionSelection {
    public static let single = "single"
    public static let multiple = "multiple"
}

/// Whether a set invites free text ("discuss further") beside a choice
/// (`optional`), instead of one (`required`), or not at all (`none`). Open-ended
/// by construction: an unknown value renders as `optional`.
public enum CodingQuestionDiscussion {
    public static let none = "none"
    public static let optional = "optional"
    public static let required = "required"
}

/// How a clarifying-question batch settled, as reported on
/// `coding_question_resolved`: `answered` by a person, `timeout` when the
/// bounded wait ran out (the runner applied its own away fallback), or
/// `cancelled` with the turn. Open-ended like every other vocabulary here.
public enum CodingQuestionResolution {
    public static let answered = "answered"
    public static let timeout = "timeout"
    public static let cancelled = "cancelled"
}

/// One clarifying-question set: a prompt, the options the agent offered, how
/// many may be chosen, and whether free text is accepted. Ids are
/// AgentRoom-minted (`set-<n>`, `opt-<n>`); `header` is the runner's short chip
/// label when it supplied one; a `sensitive` set is free-text only, entered
/// securely, and its text is never echoed back on the stream.
public struct CodingQuestionSet: Codable, Hashable, Identifiable, Sendable {
    public var setId: String
    public var header: String?
    public var prompt: String
    public var selection: String
    public var options: [CodingQuestionOption]
    public var discussion: String
    public var sensitive: Bool?

    public var id: String { setId }

    public var allowsMultipleSelection: Bool { selection == CodingQuestionSelection.multiple }
    public var allowsDiscussion: Bool { discussion != CodingQuestionDiscussion.none }
    public var requiresDiscussion: Bool { discussion == CodingQuestionDiscussion.required }
    public var isSensitive: Bool { sensitive ?? false }

    public init(
        setId: String,
        header: String? = nil,
        prompt: String,
        selection: String = CodingQuestionSelection.single,
        options: [CodingQuestionOption],
        discussion: String = CodingQuestionDiscussion.optional,
        sensitive: Bool? = nil
    ) {
        self.setId = setId
        self.header = header
        self.prompt = prompt
        self.selection = selection
        self.options = options
        self.discussion = discussion
        self.sensitive = sensitive
    }
}

/// One answered set: the chosen option ids and the person's free text where the
/// set invited it. On `coding_question_resolved` a sensitive set's text is absent.
public struct CodingQuestionAnswer: Codable, Hashable, Sendable {
    public var setId: String
    public var selectedOptionIds: [String]
    public var discussion: String?

    public init(setId: String, selectedOptionIds: [String], discussion: String? = nil) {
        self.setId = setId
        self.selectedOptionIds = selectedOptionIds
        self.discussion = discussion
    }
}

public struct CodingAgentEventPayload: Codable, Hashable, Sendable {
    public var type: CodingAgentEventType
    public var version: Int
    public var sessionId: String
    public var turnId: String?
    public var runnerKind: String
    public var runner: CodingRunnerMetadata?
    /// Legacy per-runner blocks, dual-emitted while the coding event contract
    /// floor is below 2. Prefer `runner`.
    public var codex: CodingAgentCodexMetadata?
    public var claudeCode: CodingAgentClaudeCodeMetadata?
    public var inputTokens: Int?
    public var cachedInputTokens: Int?
    public var outputTokens: Int?
    public var reasoningOutputTokens: Int?
    public var totalTokens: Int?
    /// Live context-window occupancy (latest request footprint); `totalTokens`
    /// remains the cumulative billed total for the turn.
    public var contextWindowUsedTokens: Int?
    public var modelContextWindowTokens: Int?
    public var delta: String?
    public var explanation: String?
    public var plan: [CodingPlanStep]?
    public var summary: String?
    public var files: [CodingDiffFile]?
    public var activity: CodingAgentActivity?
    public var request: [String: JSONValue]?
    public var requestId: String?
    /// The answers the agent offered, on `coding_permission_requested`. Present
    /// only for a runner whose request can actually be answered; a runner that
    /// decides from its own stored posture sends none, and the event stays the
    /// transcript entry it always was.
    public var options: [CodingPermissionOption]?
    public var status: String?
    /// On `coding_permission_resolved`: the option that was selected, and who
    /// selected it (`human`, `policy`, `timeout`). Surface the authority —
    /// "allowed" reads very differently depending on who allowed it.
    public var optionId: String?
    public var decidedBy: String?
    /// On `coding_question_requested`: the sets of a clarifying-question batch.
    /// With `requestId` they are answerable through
    /// `POST /api/agent-sessions/:id/questions/:requestId`; without it the
    /// batch is a record a client renders but cannot answer, the same rule as
    /// `options` on a permission request.
    public var questionSets: [CodingQuestionSet]?
    /// On `coding_question_resolved` after a human answer: what was chosen per
    /// answered set. `status` and `decidedBy` above say how the batch settled.
    public var questionAnswers: [CodingQuestionAnswer]?
    public var error: String?
    // Live artifact channel: `artifactId` and `kind` ("svg" | "mermaid") on
    // started, `delta` on delta (reuses the field above), and `bytes` on
    // completed. `truncated` applies to completed artifacts and bounded diff
    // summaries.
    public var artifactId: String?
    public var kind: String?
    public var title: String?
    public var bytes: Int?
    public var truncated: Bool?

    public init(
        type: CodingAgentEventType,
        version: Int,
        sessionId: String,
        turnId: String? = nil,
        runnerKind: String,
        runner: CodingRunnerMetadata? = nil,
        codex: CodingAgentCodexMetadata? = nil,
        claudeCode: CodingAgentClaudeCodeMetadata? = nil,
        inputTokens: Int? = nil,
        cachedInputTokens: Int? = nil,
        outputTokens: Int? = nil,
        reasoningOutputTokens: Int? = nil,
        totalTokens: Int? = nil,
        contextWindowUsedTokens: Int? = nil,
        modelContextWindowTokens: Int? = nil,
        delta: String? = nil,
        explanation: String? = nil,
        plan: [CodingPlanStep]? = nil,
        summary: String? = nil,
        files: [CodingDiffFile]? = nil,
        activity: CodingAgentActivity? = nil,
        request: [String: JSONValue]? = nil,
        requestId: String? = nil,
        options: [CodingPermissionOption]? = nil,
        status: String? = nil,
        optionId: String? = nil,
        decidedBy: String? = nil,
        questionSets: [CodingQuestionSet]? = nil,
        questionAnswers: [CodingQuestionAnswer]? = nil,
        error: String? = nil,
        artifactId: String? = nil,
        kind: String? = nil,
        title: String? = nil,
        bytes: Int? = nil,
        truncated: Bool? = nil
    ) {
        self.type = type
        self.version = version
        self.sessionId = sessionId
        self.turnId = turnId
        self.runnerKind = runnerKind
        self.runner = runner
        self.codex = codex
        self.claudeCode = claudeCode
        self.inputTokens = inputTokens
        self.cachedInputTokens = cachedInputTokens
        self.outputTokens = outputTokens
        self.reasoningOutputTokens = reasoningOutputTokens
        self.totalTokens = totalTokens
        self.contextWindowUsedTokens = contextWindowUsedTokens
        self.modelContextWindowTokens = modelContextWindowTokens
        self.delta = delta
        self.explanation = explanation
        self.plan = plan
        self.summary = summary
        self.files = files
        self.activity = activity
        self.request = request
        self.requestId = requestId
        self.options = options
        self.status = status
        self.optionId = optionId
        self.decidedBy = decidedBy
        self.questionSets = questionSets
        self.questionAnswers = questionAnswers
        self.error = error
        self.artifactId = artifactId
        self.kind = kind
        self.title = title
        self.bytes = bytes
        self.truncated = truncated
    }
}

public struct ArtifactSnapshot: Codable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String
    public var turnId: String
    public var kind: String
    public var title: String?
    public var content: String
    public var version: Int
    public var isOpen: Bool
    public var truncated: Bool
    public var updatedAt: String

    public init(
        id: String,
        sessionId: String,
        turnId: String,
        kind: String,
        title: String? = nil,
        content: String,
        version: Int,
        isOpen: Bool,
        truncated: Bool,
        updatedAt: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.kind = kind
        self.title = title
        self.content = content
        self.version = version
        self.isOpen = isOpen
        self.truncated = truncated
        self.updatedAt = updatedAt
    }
}

public struct AgentSessionArtifactListResponse: Codable, Hashable {
    public var artifacts: [ArtifactSnapshot]

    public init(artifacts: [ArtifactSnapshot]) {
        self.artifacts = artifacts
    }
}

public struct CodingAgentCapabilitiesResponse: Codable, Hashable {
    public var runnerKind: String
    public var settings: CodingAgentSettingsDescriptor
    public var error: String?

    public init(runnerKind: String, settings: CodingAgentSettingsDescriptor, error: String? = nil) {
        self.runnerKind = runnerKind
        self.settings = settings
        self.error = error
    }
}

public struct CodingAgentTurnSettings: Codable, Hashable {
    public var model: String?
    public var reasoningEffort: String?
    public var serviceTier: String?

    public var isEmpty: Bool {
        model == nil && reasoningEffort == nil && serviceTier == nil
    }

    public init(model: String? = nil, reasoningEffort: String? = nil, serviceTier: String? = nil) {
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.serviceTier = serviceTier
    }
}

public struct CodingAgentModelOption: Codable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?
    public var contextWindowTokens: Int?
    public var isDefault: Bool
    public var reasoningEfforts: [CodingAgentSettingValue]
    public var defaultReasoningEffort: String?
    public var serviceTiers: [CodingAgentSettingValue]
    public var defaultServiceTier: String?

    public init(
        id: String,
        label: String,
        description: String?,
        contextWindowTokens: Int? = nil,
        isDefault: Bool,
        reasoningEfforts: [CodingAgentSettingValue],
        defaultReasoningEffort: String?,
        serviceTiers: [CodingAgentSettingValue],
        defaultServiceTier: String?
    ) {
        self.id = id
        self.label = label
        self.description = description
        self.contextWindowTokens = contextWindowTokens
        self.isDefault = isDefault
        self.reasoningEfforts = reasoningEfforts
        self.defaultReasoningEffort = defaultReasoningEffort
        self.serviceTiers = serviceTiers
        self.defaultServiceTier = defaultServiceTier
    }
}

public struct CodingAgentSettingValue: Codable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?

    public init(id: String, label: String, description: String?) {
        self.id = id
        self.label = label
        self.description = description
    }
}

public struct CodingAgentSettingsDescriptor: Codable, Hashable {
    public var models: [CodingAgentModelOption]
    public var defaultSettings: CodingAgentTurnSettings

    public var defaultModel: CodingAgentModelOption? {
        models.first { $0.isDefault } ?? models.first
    }

    public init(models: [CodingAgentModelOption], defaultSettings: CodingAgentTurnSettings) {
        self.models = models
        self.defaultSettings = defaultSettings
    }

    public func model(for id: String?) -> CodingAgentModelOption? {
        guard let id else { return defaultModel }
        return models.first { $0.id == id } ?? defaultModel
    }
}

// MARK: - Editor language catalog (Phase C)

/// A backend catalog blob referenced by content hash. Large assets (TextMate
/// grammars, the Oniguruma WASM) are fetched from the bounded asset route and
/// verified against `sha256`; small assets are inlined in the manifest instead.
public struct EditorCatalogAssetRef: Codable, Hashable, Sendable {
    public var path: String
    public var sha256: String
    public var bytes: Int

    public init(path: String, sha256: String, bytes: Int) {
        self.path = path
        self.sha256 = sha256
        self.bytes = bytes
    }
}

/// One grammar binding in the served catalog: a Monaco languageId, its TextMate
/// scope, the grammar blob (by reference), and the VS Code language configuration
/// inlined as raw (JSONC) text.
public struct EditorCatalogGrammar: Codable, Hashable, Sendable {
    public var languageId: String
    public var scopeName: String
    public var grammar: EditorCatalogAssetRef
    public var languageConfig: String?

    public init(languageId: String, scopeName: String, grammar: EditorCatalogAssetRef, languageConfig: String? = nil) {
        self.languageId = languageId
        self.scopeName = scopeName
        self.grammar = grammar
        self.languageConfig = languageConfig
    }
}

public struct EditorCatalogEngine: Codable, Hashable, Sendable {
    public var onigWasm: EditorCatalogAssetRef

    public init(onigWasm: EditorCatalogAssetRef) {
        self.onigWasm = onigWasm
    }
}

/// The backend-served editor language catalog (Phase C). `version` is an aggregate
/// content hash, so it changes iff any asset changes — the client uses it plus the
/// per-asset `sha256` values to fetch only what changed into a content-addressed
/// cache. The inline maps (`languageMap`, `themes`, `textMateThemes`) reproduce the
/// bundled `EditorLanguages.json` / `EditorThemes.json` / `EditorTextMateThemes.json`.
public struct EditorCatalogManifest: Codable, Hashable, Sendable {
    public var version: String
    public var languageMap: JSONValue
    public var grammars: [EditorCatalogGrammar]
    public var themes: JSONValue
    public var textMateThemes: JSONValue
    public var engine: EditorCatalogEngine

    public init(
        version: String,
        languageMap: JSONValue,
        grammars: [EditorCatalogGrammar],
        themes: JSONValue,
        textMateThemes: JSONValue,
        engine: EditorCatalogEngine
    ) {
        self.version = version
        self.languageMap = languageMap
        self.grammars = grammars
        self.themes = themes
        self.textMateThemes = textMateThemes
        self.engine = engine
    }
}

public struct EditorCatalogResponse: Codable, Hashable {
    public var catalog: EditorCatalogManifest

    public init(catalog: EditorCatalogManifest) {
        self.catalog = catalog
    }
}

/// Which directory the backend assembled the live catalog from (Phase C.5):
/// an operator-managed override dir, the shipped bundled dir, or no catalog.
public enum EditorCatalogSource: String, Codable, Hashable, Sendable {
    // `override` is a Swift keyword; the wire value stays "override".
    case overrideDir = "override"
    case bundled
    case none
}

/// Operator-facing catalog status for the macOS catalog pane. Carries no asset
/// content — only the live source + aggregate version + language count.
public struct EditorCatalogStatus: Codable, Hashable, Sendable {
    public var enabled: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var languageCount: Int

    public init(enabled: Bool, source: EditorCatalogSource, version: String?, languageCount: Int) {
        self.enabled = enabled
        self.source = source
        self.version = version
        self.languageCount = languageCount
    }
}

/// Result of an operator-triggered catalog reload (Phase C.5). `changed` is true
/// only when the aggregate version moved, which is also when the backend broadcasts
/// `editor_catalog_changed` so paired visionOS clients re-hydrate.
public struct EditorCatalogReloadResult: Codable, Hashable, Sendable {
    public var reloaded: Bool
    public var source: EditorCatalogSource
    public var version: String?
    public var changed: Bool

    public init(reloaded: Bool, source: EditorCatalogSource, version: String?, changed: Bool) {
        self.reloaded = reloaded
        self.source = source
        self.version = version
        self.changed = changed
    }
}
