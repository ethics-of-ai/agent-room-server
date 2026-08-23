import XCTest
import Security
@testable import AgentRoomMac

/// Mac bootstrap readiness end to end: the supervisor runs the bundled probes,
/// persists what they resolve, and contributes blocking items for **the default
/// runner only**.
@MainActor
final class BackendSupervisorRunnerBootstrapTests: XCTestCase {
    func testDetectedExecutableIsSavedIntoTheRunnersSlot() throws {
        let installed = try makeExecutable(named: "codex")
        let secretStore = InMemoryBackendSecretStore()
        let supervisor = makeSupervisor(
            secretStore: secretStore,
            prober: RunnerBootstrapTestSupport.prober(codexCandidates: [installed])
        )

        XCTAssertEqual(
            supervisor.bootstrapStatus(runnerKind: "codex", probeID: "executable"),
            .detected(detail: installed.path)
        )
        XCTAssertEqual(secretStore.values.slotValue(runnerKind: "codex", slotID: "executable"), installed.path)
        XCTAssertFalse(supervisor.setupReadiness.blockingItems.contains("Install Codex CLI, then rerun the check."))
    }

    func testMissingExecutableBlocksSetupForTheRunnerThatNeedsIt() {
        let supervisor = makeSupervisor(prober: RunnerBootstrapTestSupport.prober())

        XCTAssertEqual(supervisor.bootstrapStatus(runnerKind: "codex", probeID: "executable"), .absent)
        XCTAssertTrue(supervisor.setupReadiness.blockingItems.contains("Install Codex CLI, then rerun the check."))
    }

    func testAnotherRunnersUnmetPrerequisiteDoesNotBlockSetup() {
        // Codex has no CLI here, but the backend is going to start Claude Code:
        // reporting Codex's gap would be asking the operator to fix something
        // that has no bearing on the runner their sessions will use.
        let supervisor = makeSupervisor(
            runnerKind: "claude_code",
            prober: RunnerBootstrapTestSupport.prober(keychainStatus: errSecSuccess)
        )

        XCTAssertEqual(supervisor.bootstrapStatus(runnerKind: "codex", probeID: "executable"), .absent)
        XCTAssertFalse(supervisor.setupReadiness.blockingItems.contains { $0.contains("Codex") })
        XCTAssertFalse(supervisor.setupReadiness.blockingItems.contains { $0.contains("claude login") })
    }

    func testSignedOutClaudeCodeBlocksSetupWhileItsMissingCLIDoesNot() {
        let supervisor = makeSupervisor(
            runnerKind: "claude_code",
            prober: RunnerBootstrapTestSupport.prober(keychainStatus: errSecItemNotFound)
        )

        let blocking = supervisor.setupReadiness.blockingItems
        XCTAssertTrue(blocking.contains("Sign in with claude login so Claude Code turns can authenticate."))
        // The bundled Agent SDK CLI runs turns, so a missing local `claude` is
        // reported and never blocking.
        XCTAssertEqual(supervisor.bootstrapStatus(runnerKind: "claude_code", probeID: "executable"), .absent)
        XCTAssertFalse(blocking.contains { $0.contains("model list") })
    }

    func testMissingDeepSeekCompositionBlocksSetupAfterTheRuntimeIsFound() throws {
        let runtime = try makeExecutable(named: "dsh-jsonrpc-agent")
        let supervisor = makeSupervisor(
            runnerKind: "deepseek",
            prober: RunnerBootstrapTestSupport.prober(deepseekCandidates: [runtime])
        )

        XCTAssertEqual(
            supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "executable"),
            .detected(detail: runtime.path)
        )
        XCTAssertEqual(supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "cordisConfig"), .absent)
        XCTAssertTrue(
            supervisor.setupReadiness.blockingItems.contains(
                "Choose an existing DeepSeek Harness Cordis composition, then rerun the check."
            )
        )
    }

    func testEditingAValidatedCompositionInvalidatesItsReadiness() throws {
        let runtime = try makeExecutable(named: "dsh-jsonrpc-agent")
        let composition = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("cordis.yml")
        addTeardownBlock { try? FileManager.default.removeItem(at: composition.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(
            at: composition.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "plugins: []\n".write(to: composition, atomically: true, encoding: .utf8)
        var initialSecrets = BackendSecretValues.empty
        initialSecrets.setSlotValue(composition.path, runnerKind: "deepseek", slotID: "cordisConfig")
        let supervisor = makeSupervisor(
            runnerKind: "deepseek",
            secretStore: InMemoryBackendSecretStore(values: initialSecrets),
            prober: RunnerBootstrapTestSupport.prober(deepseekCandidates: [runtime])
        )

        XCTAssertEqual(
            supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "cordisConfig"),
            .satisfied(detail: composition.path)
        )

        supervisor.updateRunnerBootstrapSlot(
            "/missing/cordis.yml",
            runnerKind: "deepseek",
            slotID: "cordisConfig"
        )

        XCTAssertNil(supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "cordisConfig"))
        XCTAssertTrue(
            supervisor.setupReadiness.blockingItems.contains(
                "Set or check the DeepSeek Harness Cordis composition path."
            )
        )
    }

    func testARunnerThisBuildHasNoBootstrapForContributesNoCheck() {
        // A runner a newer backend registers. This app cannot say whether its
        // local prerequisites are met, and asserting another runner's answer
        // would be worse than saying nothing.
        let supervisor = makeSupervisor(runnerKind: "acp_demo", prober: RunnerBootstrapTestSupport.prober())

        let blocking = supervisor.setupReadiness.blockingItems
        XCTAssertFalse(blocking.contains { $0.contains("Codex") })
        XCTAssertFalse(blocking.contains { $0.contains("claude login") })
    }

    func testAPublicRunnerWithoutLocalBootstrapStillGetsRuntimePresentation() {
        let supervisor = makeSupervisor(prober: RunnerBootstrapTestSupport.prober())
        supervisor.applyRunnerCatalog(
            RunnerCatalogResponse(runners: [
                RunnerDescriptor(
                    runnerKind: "acp_demo",
                    displayName: "ACP Demo",
                    registered: true,
                    configured: true,
                    enabled: true,
                    ready: false
                )
            ])
        )

        XCTAssertEqual(
            supervisor.runnerSettingsDescriptors.map(\.runnerKind),
            ["acp_demo", "codex", "claude_code", "deepseek"]
        )
        XCTAssertEqual(supervisor.runnerSettingsDescriptors.first?.ready, false)
        XCTAssertNil(supervisor.runnerBootstrapDescriptor(for: "acp_demo"))
    }

    func testRuntimeReadinessRefreshesTheCatalogAfterCapabilitiesFails() async {
        let supervisor = makeSupervisor(
            prober: RunnerBootstrapTestSupport.prober(),
            apiURLSession: RunnerReadinessFailureURLProtocol.session()
        )
        supervisor.applyRunnerCatalog(
            RunnerCatalogResponse(runners: [
                RunnerDescriptor(
                    runnerKind: "codex",
                    displayName: "Codex",
                    registered: true,
                    configured: true,
                    enabled: true,
                    ready: true
                )
            ])
        )

        await supervisor.checkRunnerRuntimeReadiness(runnerKind: "codex")

        XCTAssertEqual(supervisor.runnerCatalog.descriptor(for: "codex").ready, false)
        XCTAssertTrue(supervisor.diagnostics.contains { $0.message.contains("Runner readiness check failed") })
    }

    func testAStoredExecutableSatisfiesSetupBeforeAnyProbeHasRun() throws {
        let installed = try makeExecutable(named: "codex")
        let readiness = SetupReadiness(
            settings: .defaults,
            runnerKind: "codex",
            secrets: {
                var secrets = BackendSecretValues.empty
                secrets.setSlotValue(installed.path, runnerKind: "codex", slotID: "executable")
                return secrets
            }(),
            bootstrapDescriptor: RunnerBootstrapTestSupport.descriptor("codex"),
            bootstrapStatuses: [:],
            connectionState: .reachable,
            hasLANURL: true
        )

        XCTAssertFalse(readiness.blockingItems.contains { $0.contains("Codex") })
    }

    private func makeSupervisor(
        runnerKind: String? = nil,
        secretStore: InMemoryBackendSecretStore = InMemoryBackendSecretStore(),
        prober: RunnerBootstrapProber,
        apiURLSession: URLSession = .shared
    ) -> BackendSupervisor {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: rootURL) }
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(rootURL.path, forKey: "agentRoomHomePath")
        defaults.set(rootURL.appendingPathComponent("workspaces", isDirectory: true).path, forKey: "workspacePath")
        defaults.set(rootURL.appendingPathComponent("state", isDirectory: true).path, forKey: "statePath")
        let supervisor = BackendSupervisor(
            defaults: defaults,
            secretStore: secretStore,
            bootstrapProber: prober,
            apiURLSession: apiURLSession,
            launchAtLoginController: InMemoryLaunchAtLoginController()
        )
        if let runnerKind {
            supervisor.updateRunnerKind(runnerKind)
        }
        return supervisor
    }

    private func makeExecutable(named name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent(name)
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        try RunnerBootstrapTestSupport.makeExecutableFile(at: url)
        return url
    }
}

private final class InMemoryBackendSecretStore: BackendSecretStore {
    var values: BackendSecretValues

    init(values: BackendSecretValues = .empty) {
        self.values = values
    }

    func loadSecrets() throws -> BackendSecretValues {
        values
    }

    func saveSecrets(_ values: BackendSecretValues) throws {
        self.values = values
    }
}

private struct InMemoryLaunchAtLoginController: LaunchAtLoginManaging {
    var isEnabled = false

    func setEnabled(_ isEnabled: Bool) throws {}
}
