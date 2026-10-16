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

    func testSignedOutCursorBlocksSetupOnlyWhenCursorIsTheDefaultRunner() {
        let cursorDefault = makeSupervisor(runnerKind: "cursor", prober: RunnerBootstrapTestSupport.prober())
        let codexDefault = makeSupervisor(prober: RunnerBootstrapTestSupport.prober())

        XCTAssertEqual(cursorDefault.bootstrapStatus(runnerKind: "cursor", probeID: "signIn"), .absent)
        XCTAssertTrue(
            cursorDefault.setupReadiness.blockingItems.contains(
                "Sign in to Cursor with the sign-in command so Cursor turns can authenticate."
            )
        )
        // The same absent sign-in is not a setup failure on a Mac whose backend
        // is going to start Codex.
        XCTAssertEqual(codexDefault.bootstrapStatus(runnerKind: "cursor", probeID: "signIn"), .absent)
        XCTAssertFalse(codexDefault.setupReadiness.blockingItems.contains { $0.contains("Cursor") })
    }

    func testMissingDeepSeekCompositionBlocksSetupAfterTheRuntimeIsFound() throws {
        let runtime = try makeExecutable(named: "dsh")
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
                "Choose an existing DeepSeek Harness Cordis patch, or select AgentRoom managed setup."
            )
        )
    }

    func testAdoptingAnOutdatedCheckoutSavesItsPathsSelectsManagedSetupAndOffersTheUpdate() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("deepseek-harness")
        addTeardownBlock { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try RunnerBootstrapTestSupport.makePackage(at: root.appendingPathComponent("apps/cli"), version: "0.1.0-rc.7")
        // The walk searches this Mac for node. Whether or not it finds one, the
        // executable slot ends up naming a node, which the entrypoint check needs.
        var initialSecrets = BackendSecretValues.empty
        initialSecrets.setSlotValue("/usr/bin/node", runnerKind: "deepseek", slotID: "executable")
        let secretStore = InMemoryBackendSecretStore(values: initialSecrets)
        let supervisor = makeSupervisor(runnerKind: "deepseek", secretStore: secretStore, prober: RunnerBootstrapTestSupport.prober())
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")

        supervisor.adoptSourceCheckout(root, of: descriptor)

        let entrypoint = root.resolvingSymlinksInPath().appendingPathComponent("apps/cli/lib/bin.js").path
        XCTAssertEqual(secretStore.values.slotValue(runnerKind: "deepseek", slotID: "arguments"), entrypoint)
        XCTAssertEqual(secretStore.values.slotValue(runnerKind: "deepseek", slotID: "compositionMode"), "managed")
        let outcome = try XCTUnwrap(supervisor.sourceCheckoutOutcomes["deepseek"])
        XCTAssertEqual(outcome.repair, .update(revision: "86a402200d95fecef4529d969836f1fe13c6cb0d"))
        // The probes reran against the new values, so the old launcher fails
        // its check instead of keeping an earlier answer.
        guard case .failed = supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "entrypoint") else {
            return XCTFail("expected the outdated launcher to fail the entrypoint check")
        }

        // A relaunch finds the same checkout from the saved entrypoint alone.
        let relaunched = makeSupervisor(
            runnerKind: "deepseek",
            secretStore: InMemoryBackendSecretStore(values: secretStore.values),
            prober: RunnerBootstrapTestSupport.prober()
        )
        XCTAssertEqual(relaunched.sourceCheckoutOutcomes["deepseek"]?.repair, outcome.repair)

        // An entrypoint from outside any checkout leaves nothing for that
        // checkout's message to describe, so the next check drops it.
        relaunched.updateRunnerBootstrapSlot("/opt/dsh/lib/bin.js", runnerKind: "deepseek", slotID: "arguments")
        relaunched.checkRunnerBootstrap()
        XCTAssertNil(relaunched.sourceCheckoutOutcomes["deepseek"])
    }

    func testManagedDeepSeekSetupDoesNotWaitForAComposition() throws {
        let runtime = try makeExecutable(named: "dsh")
        var initialSecrets = BackendSecretValues.empty
        initialSecrets.setSlotValue("managed", runnerKind: "deepseek", slotID: "compositionMode")
        let supervisor = makeSupervisor(
            runnerKind: "deepseek",
            secretStore: InMemoryBackendSecretStore(values: initialSecrets),
            prober: RunnerBootstrapTestSupport.prober(deepseekCandidates: [runtime])
        )

        XCTAssertEqual(supervisor.bootstrapStatus(runnerKind: "deepseek", probeID: "cordisConfig"), .absent)
        XCTAssertFalse(supervisor.setupReadiness.blockingItems.contains { $0.contains("composition") })
        let compositionAbsent = try XCTUnwrap(
            RunnerBootstrapTestSupport.descriptor("deepseek").probe("cordisConfig")?.messages.absent
        )
        XCTAssertEqual(
            supervisor.diagnostics.first { $0.message == compositionAbsent }?.level,
            "info"
        )

        // Switching back to custom puts the composition back on the checklist
        // without a re-probe: the stored absence now blocks again.
        supervisor.updateRunnerBootstrapSlot("custom", runnerKind: "deepseek", slotID: "compositionMode")

        XCTAssertTrue(
            supervisor.setupReadiness.blockingItems.contains(
                "Choose an existing DeepSeek Harness Cordis patch, or select AgentRoom managed setup."
            )
        )
    }

    func testEditingAValidatedCompositionInvalidatesItsReadiness() throws {
        let runtime = try makeExecutable(named: "dsh")
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
                "Set or check the DeepSeek Harness composition, or select AgentRoom managed setup."
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
            ["acp_demo", "codex", "claude_code", "deepseek", "cursor"]
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

        // An operator's check must not be answered from the backend cache.
        XCTAssertEqual(RunnerReadinessFailureURLProtocol.capabilitiesQuery, "runnerKind=codex&refresh=true")
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
