import XCTest
@testable import AgentRoomMac

final class BackendRuntimeLocatorTests: XCTestCase {
    func testLaunchConfigurationInjectsOnlyBridgeEnvironment() {
        let runtime = BackendRuntime(
            nodeExecutableURL: URL(fileURLWithPath: "/usr/bin/node"),
            backendEntrypointURL: URL(fileURLWithPath: "/tmp/backend/dist/index.js")
        )
        var settings = AppSettings(
            serverPort: 8799,
            workspacePath: "/tmp/workspaces",
            statePath: "/tmp/state",
            agentRoomHomePath: "/tmp/AgentRoom"
        )
        settings.remoteSettingsAdminEnabled = true
        var secrets = BackendSecretValues(authToken: "auth-token", legacyCodexReasoningEffort: "high")
        secrets.setSlotValue("/opt/homebrew/bin/codex", runnerKind: "codex", slotID: "executable")
        secrets.setSlotValue("app-server,--listen,stdio://", runnerKind: "codex", slotID: "arguments")
        secrets.setSlotValue("/opt/homebrew/bin/dsh-jsonrpc-agent", runnerKind: "deepseek", slotID: "executable")
        secrets.setSlotValue("/Users/me/.dsh/agentroom/cordis.yml", runnerKind: "deepseek", slotID: "cordisConfig")
        // A stored value for a runner no bundled descriptor covers: preserved in
        // Keychain, never injected, because the descriptors are the allowlist.
        secrets.setSlotValue("/opt/tools/acp", runnerKind: "acp_demo", slotID: "executable")

        let configuration = BackendLaunchConfiguration(
            runtime: runtime,
            settings: settings,
            secrets: secrets,
            baseEnvironment: [
                "SOURCE_REPO_PATH": "/tmp/old"
            ]
        )

        XCTAssertEqual(configuration.executableURL, runtime.nodeExecutableURL)
        XCTAssertEqual(configuration.arguments, [runtime.backendEntrypointURL.path])
        XCTAssertEqual(configuration.environment["AGENTROOM_HOME"], "/tmp/AgentRoom")
        XCTAssertEqual(configuration.environment["WORKSPACE_ROOT"], "/tmp/workspaces")
        XCTAssertEqual(configuration.environment["STATE_DIR"], "/tmp/state")
        XCTAssertEqual(configuration.environment["EDITOR_CATALOG_DIR"], "/tmp/AgentRoom/catalog-assets")
        XCTAssertEqual(configuration.environment["PORT"], "8799")
        XCTAssertEqual(configuration.environment["HOST"], "0.0.0.0")
        XCTAssertEqual(configuration.environment["AUTH_TOKEN"], "auth-token")
        XCTAssertEqual(configuration.environment["CODEX_EXECUTABLE"], "/opt/homebrew/bin/codex")
        XCTAssertNil(configuration.environment["CODEX_REASONING_EFFORT"])
        XCTAssertEqual(configuration.environment["CODEX_ARGS"], "app-server,--listen,stdio://")
        // The SDK runtime, not the `dsh` launcher, and the composition it
        // refuses to start without.
        XCTAssertEqual(configuration.environment["DEEPSEEK_EXECUTABLE"], "/opt/homebrew/bin/dsh-jsonrpc-agent")
        XCTAssertEqual(configuration.environment["DEEPSEEK_CORDIS_CONFIG"], "/Users/me/.dsh/agentroom/cordis.yml")
        // The Codex adapter owns its own protocol bootstrap now: generic launch
        // assembly no longer derives `CODEX_RUNNER_PROTOCOL` from a managed
        // setting, which also stops it overriding an operator who pinned `exec`.
        XCTAssertNil(configuration.environment["CODEX_RUNNER_PROTOCOL"])
        XCTAssertEqual(configuration.environment.values.contains("/opt/tools/acp"), false)
        XCTAssertEqual(configuration.environment["REMOTE_SETTINGS_ADMIN"], "true")
        XCTAssertNil(configuration.environment["SOURCE_REPO_PATH"])
    }

    /// Managed settings live in the backend's own settings.json, which is what
    /// lets a paired client read and change them; injecting them here would lock
    /// every one of those keys to `source: "env"` and make the file inert.
    func testLaunchConfigurationDoesNotInjectManagedSettings() {
        let runtime = BackendRuntime(
            nodeExecutableURL: URL(fileURLWithPath: "/usr/bin/node"),
            backendEntrypointURL: URL(fileURLWithPath: "/tmp/backend/dist/index.js")
        )
        let configuration = BackendLaunchConfiguration(
            runtime: runtime,
            settings: makeSettings(),
            secrets: .empty
        )

        XCTAssertNil(configuration.environment["RUNNER_KIND"])
        XCTAssertNil(configuration.environment["CODEX_REASONING_EFFORT"])
        XCTAssertNil(configuration.environment["TERMINAL_ENABLED"])
        XCTAssertNil(configuration.environment["SCENE_ENGINE_ENABLED"])
        XCTAssertNil(configuration.environment["CODEX_SANDBOX_MODE"])
        XCTAssertNil(configuration.environment["CODEX_WORKSPACE_NETWORK_ACCESS"])
    }

    /// A value inherited from whatever launched this app — a shell export, an
    /// Xcode scheme — must not silently lock a key the panes present as editable.
    /// Deliberate locking still works through the app-managed config `.env`, which
    /// the backend loads itself.
    func testLaunchConfigurationStripsInheritedManagedEnvironment() {
        let runtime = BackendRuntime(
            nodeExecutableURL: URL(fileURLWithPath: "/usr/bin/node"),
            backendEntrypointURL: URL(fileURLWithPath: "/tmp/backend/dist/index.js")
        )

        let configuration = BackendLaunchConfiguration(
            runtime: runtime,
            settings: makeSettings(),
            secrets: .empty,
            baseEnvironment: [
                "RUNNER_KIND": "claude_code",
                "CODEX_APPROVAL_POLICY": "on-request",
                "CODEX_RUNNER_PROTOCOL": "exec",
                "CODEX_ARGS": "exec,--sandbox,workspace-write",
                "CODEX_SANDBOX_MODE": "danger-full-access",
                "CODEX_WORKSPACE_NETWORK_ACCESS": "true",
                "TERMINAL_ENABLED": "true",
                "SCENE_ENGINE_ENABLED": "false",
                "REMOTE_SETTINGS_ADMIN": "true"
            ]
        )

        XCTAssertNil(configuration.environment["RUNNER_KIND"])
        XCTAssertNil(configuration.environment["CODEX_APPROVAL_POLICY"])
        XCTAssertNil(configuration.environment["CODEX_RUNNER_PROTOCOL"])
        XCTAssertNil(configuration.environment["CODEX_ARGS"])
        XCTAssertNil(configuration.environment["CODEX_SANDBOX_MODE"])
        XCTAssertNil(configuration.environment["CODEX_WORKSPACE_NETWORK_ACCESS"])
        XCTAssertNil(configuration.environment["TERMINAL_ENABLED"])
        XCTAssertNil(configuration.environment["SCENE_ENGINE_ENABLED"])
        // The master switch is app state, so an inherited value never grants it.
        XCTAssertEqual(configuration.environment["REMOTE_SETTINGS_ADMIN"], "false")
    }

    func testLaunchConfigurationAddsCommonDeveloperToolPaths() {
        let runtime = BackendRuntime(
            nodeExecutableURL: URL(fileURLWithPath: "/usr/bin/node"),
            backendEntrypointURL: URL(fileURLWithPath: "/tmp/backend/dist/index.js")
        )

        let configuration = BackendLaunchConfiguration(
            runtime: runtime,
            settings: makeSettings(),
            secrets: .empty,
            baseEnvironment: [
                "PATH": "/usr/bin:/bin"
            ]
        )

        let pathComponents = configuration.environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        XCTAssertTrue(pathComponents.contains("/opt/homebrew/bin"))
        XCTAssertTrue(pathComponents.contains("/usr/local/bin"))
        XCTAssertTrue(pathComponents.contains("/usr/bin"))
        XCTAssertTrue(pathComponents.contains("/bin"))
    }

    func testAppSupportMigratorCreatesBridgeDirectoriesWithoutGitState() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let settings = AppSettings(
            serverPort: 8787,
            workspacePath: root.appendingPathComponent("workspaces", isDirectory: true).path,
            statePath: root.appendingPathComponent("state", isDirectory: true).path,
            agentRoomHomePath: root.path
        )

        let result = try AppSupportDataMigrator().migrateIfNeeded(settings: settings)

        XCTAssertEqual(result.schemaVersion, AppSupportDataMigrator.currentSchemaVersion)
        XCTAssertTrue(FileManager.default.fileExists(atPath: settings.workspacePath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: settings.statePath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: "\(settings.agentRoomHomePath)/config"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: "\(settings.agentRoomHomePath)/source-repo"))
    }

    func testDiagnosticsRedactsConfiguredSecrets() throws {
        var secrets = BackendSecretValues(authToken: "auth-token-secret")
        secrets.setSlotValue("/opt/homebrew/bin/codex", runnerKind: "codex", slotID: "executable")
        secrets.setSlotValue("exec --token hidden", runnerKind: "codex", slotID: "arguments")
        let settings = makeSettings()
        let bundle = DiagnosticsBundle(
            generatedAt: Date(timeIntervalSince1970: 0),
            app: DiagnosticsBundle.AppSection(
                serverState: "Running",
                connectionState: "Reachable",
                localServerURL: "http://localhost:8787",
                lanServerURLs: [],
                settings: SanitizedSettings(settings: settings, managedSettings: ManagedBackendSettings()),
                configuredSecrets: SanitizedSecretStatus(secrets: secrets)
            ),
            backend: DiagnosticsBundle.BackendSection(
                health: "auth-token-secret",
                config: "exec --token hidden",
                recentLogs: "/opt/homebrew/bin/codex",
                auditTrail: nil
            ),
            localDiagnostics: [],
            processLogs: []
        ).redactingSecrets(secrets)

        let data = try JSONEncoder.diagnosticsEncoder.encode(bundle)
        let json = String(decoding: data, as: UTF8.self)

        XCTAssertFalse(json.contains("auth-token-secret"))
        XCTAssertFalse(json.contains("exec --token hidden"))
        XCTAssertFalse(json.contains("/opt/homebrew/bin/codex"))
        XCTAssertTrue(json.contains("\"authTokenConfigured\" : true"))
    }

    func testSanitizedSettingsIncludeManagedBackendSettings() throws {
        var managedSettings = ManagedBackendSettings()
        managedSettings.setCodexGitNetworkAccess(true)

        let data = try JSONEncoder.diagnosticsEncoder.encode(
            SanitizedSettings(settings: makeSettings(), managedSettings: managedSettings)
        )
        let json = String(decoding: data, as: UTF8.self)

        XCTAssertTrue(json.contains("\"codexWorkspaceNetworkAccess\" : true"))
        XCTAssertTrue(json.contains("\"codexSandboxMode\" : \"danger-full-access\""))
        XCTAssertTrue(json.contains("\"remoteSettingsAdminEnabled\" : false"))
    }

    private func makeSettings() -> AppSettings {
        AppSettings(
            serverPort: 8787,
            workspacePath: "/tmp/workspaces",
            statePath: "/tmp/state",
            agentRoomHomePath: "/tmp/AgentRoom"
        )
    }
}
