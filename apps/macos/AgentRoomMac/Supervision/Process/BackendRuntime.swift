import Foundation

struct BackendRuntime: Equatable {
    var nodeExecutableURL: URL
    var backendEntrypointURL: URL
}

struct BackendLaunchConfiguration: Equatable {
    static let managedEnvironmentNames = [
        "AGENTROOM_HOME",
        "WORKSPACE_ROOT",
        "STATE_DIR",
        "EDITOR_CATALOG_DIR",
        "PORT",
        "HOST",
        "SOURCE_REPO_PATH",
        "RUNNER_KIND",
        "CODEX_RUNNER_PROTOCOL",
        "CODEX_APPROVAL_POLICY",
        "CODEX_SANDBOX_MODE",
        "CODEX_WORKSPACE_NETWORK_ACCESS",
        "TERMINAL_ENABLED",
        "SCENE_ENGINE_ENABLED",
        "REMOTE_SETTINGS_ADMIN",
        "AGENTROOM_EXIT_WITH_PARENT",
        "AGENTROOM_PARENT_PID"
    ]

    var executableURL: URL
    var arguments: [String]
    var environment: [String: String]
    var currentDirectoryURL: URL

    /// Deliberately takes **no** managed settings. Everything managed lives in
    /// the backend's own `settings.json`, and a launch that read one would be
    /// generic Swift interpreting a particular runner's configuration — the
    /// coupling `docs/engineering/RUNNERS.md` removes. Omitting the parameter
    /// is what keeps it removed.
    init(
        runtime: BackendRuntime,
        settings: AppSettings,
        secrets: BackendSecretValues = .empty,
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        var environment = baseEnvironment
        for name in Self.managedEnvironmentNames {
            environment.removeValue(forKey: name)
        }
        for name in BackendSecretValues.managedEnvironmentNames {
            environment.removeValue(forKey: name)
        }
        environment["AGENTROOM_HOME"] = settings.agentRoomHomePath
        environment["PORT"] = String(settings.serverPort)
        environment["HOST"] = "0.0.0.0"
        environment["WORKSPACE_ROOT"] = settings.workspacePath
        if !settings.usesDefaultStatePath {
            environment["STATE_DIR"] = settings.statePath
        }
        // The operator-managed editor catalog override dir. Injected
        // explicitly so the macOS import target and the backend read path are one
        // source of truth (the backend default resolves the same AGENTROOM_HOME
        // path, but being explicit makes the contract testable).
        environment["EDITOR_CATALOG_DIR"] = settings.editorCatalogPath
        // Tier-3 launch values, injected only under the environment names the
        // bundled bootstrap descriptors declare (docs/engineering/RUNNERS.md).
        // Assembly here is
        // generic: it iterates the allowlist and never interprets what a
        // particular runner's value means.
        environment.merge(secrets.environment()) { _, secretValue in secretValue }
        // Managed settings (runner/model/effort defaults, the Codex
        // sandbox/network pair, and the feature/trust toggles) are deliberately
        // *not* injected: they live in the backend's own settings.json, which is
        // what lets a paired client see and change them. Their names stay in the
        // strip list above, though, so a
        // value inherited from whatever launched this app — a shell export, an
        // Xcode scheme — cannot silently lock a control the panes present as
        // editable. Deliberate environment locking still works through the
        // app-managed `$AGENTROOM_HOME/config/.env`, which the backend loads
        // itself and reports as `source: "env"`.
        //
        // Nothing here reads a managed value. This used to force
        // `CODEX_RUNNER_PROTOCOL` and `CODEX_ARGS` whenever the Codex network
        // toggle was on — generic launch assembly deciding what one runner's
        // protocol needs, which also overrode an operator who had pinned `exec`
        // on purpose. The Codex adapter owns that decision now: JSON-RPC is its
        // default protocol and it starts its own app-server when the operator's
        // arguments do not (`runner/codex/settings.ts`).
        environment["REMOTE_SETTINGS_ADMIN"] = settings.remoteSettingsAdminEnabled ? "true" : "false"
        // The sidecar stops when this app does. `applicationWillTerminate`
        // handles a normal quit, but a force quit, a crash, or Xcode's stop
        // button never reaches it, and the reparented backend then holds the
        // port with nobody supervising it. Set only here, so a backend an
        // operator runs themselves is never ended by a parent's exit. See
        // `apps/backend/src/util/parentExitWatchdog.ts`.
        environment["AGENTROOM_EXIT_WITH_PARENT"] = "true"
        // Capture the launcher identity instead of relying only on the child's
        // eventual `getppid()`: if the app dies before Node arms its watchdog,
        // the already-reparented child can still detect the mismatch at once.
        environment["AGENTROOM_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["PATH"] = Self.developerToolPath(from: environment["PATH"])

        self.executableURL = runtime.nodeExecutableURL
        self.arguments = [runtime.backendEntrypointURL.path]
        self.environment = environment
        self.currentDirectoryURL = runtime.backendEntrypointURL.deletingLastPathComponent()
    }

    private static func developerToolPath(from basePath: String?) -> String {
        let defaultPaths = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ]
        var seen = Set<String>()
        var components: [String] = []
        for component in (basePath?.split(separator: ":").map(String.init) ?? []) + defaultPaths {
            guard !component.isEmpty, seen.insert(component).inserted else {
                continue
            }
            components.append(component)
        }
        return components.joined(separator: ":")
    }
}

enum BackendRuntimeLocatorError: LocalizedError {
    case missingNode(candidates: [String])
    case missingBackendEntrypoint(candidates: [String])

    var errorDescription: String? {
        switch self {
        case .missingNode(let candidates):
            return "Could not find a Node.js runtime. Checked: \(candidates.joined(separator: ", "))"
        case .missingBackendEntrypoint(let candidates):
            return "Could not find the compiled backend entrypoint. Checked: \(candidates.joined(separator: ", "))"
        }
    }
}

struct BackendRuntimeLocator {
    var environment: [String: String]
    var bundledRuntimeCandidates: [URL]
    var developmentRuntimeCandidates: [URL]

    private let fileManager: FileManager

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        bundledRuntimeCandidates: [URL]? = nil,
        developmentRuntimeCandidates: [URL]? = nil
    ) {
        self.environment = environment
        self.fileManager = fileManager

        let resourceURL = bundle.resourceURL
        self.bundledRuntimeCandidates = bundledRuntimeCandidates ?? Self.defaultBundledBackendCandidates(resourceURL: resourceURL)
        self.developmentRuntimeCandidates = developmentRuntimeCandidates ?? Self.defaultDevelopmentBackendCandidates()
    }

    func locateRuntime() throws -> BackendRuntime {
        let nodeCandidates = explicitCandidate(named: "AGENTROOM_NODE_EXECUTABLE").map { [$0] } ?? defaultNodeCandidates()
        let backendCandidates = explicitCandidate(named: "AGENTROOM_BACKEND_ENTRYPOINT").map { [$0] }
            ?? bundledRuntimeCandidates + developmentRuntimeCandidates

        guard let nodeExecutableURL = nodeCandidates.first(where: isExecutableFile) else {
            throw BackendRuntimeLocatorError.missingNode(candidates: nodeCandidates.map(\.path))
        }
        guard let backendEntrypointURL = backendCandidates.first(where: fileExists) else {
            throw BackendRuntimeLocatorError.missingBackendEntrypoint(candidates: backendCandidates.map(\.path))
        }

        return BackendRuntime(nodeExecutableURL: nodeExecutableURL, backendEntrypointURL: backendEntrypointURL)
    }

    private func explicitCandidate(named name: String) -> URL? {
        guard let value = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: NSString(string: value).expandingTildeInPath)
    }

    private func defaultNodeCandidates() -> [URL] {
        var candidates: [URL] = []
        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("node/bin/node"))
            candidates.append(resourceURL.appendingPathComponent("node"))
        }
        candidates.append(contentsOf: [
            URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            URL(fileURLWithPath: "/usr/local/bin/node"),
            URL(fileURLWithPath: "/usr/bin/node")
        ])
        return candidates
    }

    private func isExecutableFile(_ url: URL) -> Bool {
        fileManager.isExecutableFile(atPath: url.path)
    }

    private func fileExists(_ url: URL) -> Bool {
        fileManager.fileExists(atPath: url.path)
    }

    private static func defaultBundledBackendCandidates(resourceURL: URL?) -> [URL] {
        guard let resourceURL else {
            return []
        }
        return [
            resourceURL.appendingPathComponent("backend/dist/index.js"),
            resourceURL.appendingPathComponent("AgentRoomBackend/index.js"),
            resourceURL.appendingPathComponent("index.js")
        ]
    }

    private static func defaultDevelopmentBackendCandidates() -> [URL] {
        let currentDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let sourceFile = URL(fileURLWithPath: #filePath)
        let repositoryRoot = sourceFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return [
            currentDirectory.appendingPathComponent("../backend/dist/index.js").standardizedFileURL,
            currentDirectory.appendingPathComponent("../../apps/backend/dist/index.js").standardizedFileURL,
            repositoryRoot.appendingPathComponent("apps/backend/dist/index.js").standardizedFileURL
        ]
    }
}
