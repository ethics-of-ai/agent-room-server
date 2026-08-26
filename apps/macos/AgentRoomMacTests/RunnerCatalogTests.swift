import XCTest
@testable import AgentRoomMac

/// What this Mac shows for a runner it has never heard of.
///
/// Phase 4 of `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` moves the list of
/// runners onto `GET /api/runners`, which this app reads when the backend is up
/// and falls back from when it is not — and it is stopped exactly when an
/// operator is fixing why it would not start. The rule that matters here is the
/// negative one: an unknown runner id is never resolved to a known runner, since
/// showing "Codex" for a backend configured for something else would report a
/// setup this Mac never established.
@MainActor
final class RunnerCatalogTests: XCTestCase {
    private let thirdRunner = RunnerDescriptor(
        runnerKind: "acp_demo",
        displayName: "ACP Demo",
        registered: true,
        configured: true,
        enabled: true
    )

    func testTheOfflineFloorNamesTheRunnersThisBuildShipsKnowing() {
        XCTAssertEqual(
            RunnerCatalog.builtIn.descriptors.map(\.runnerKind),
            ["codex", "claude_code", "deepseek", "cursor"]
        )
        XCTAssertEqual(RunnerCatalog.builtIn.displayName(for: "codex"), "Codex")
        XCTAssertEqual(RunnerCatalog.builtIn.displayName(for: "deepseek"), "DeepSeek Harness")
        XCTAssertEqual(RunnerCatalog.builtIn.displayName(for: "cursor"), "Cursor")
    }

    func testASyntheticThirdDescriptorRendersUnderItsOwnName() {
        let catalog = RunnerCatalog(descriptors: RunnerCatalog.builtIn.descriptors + [thirdRunner])

        XCTAssertEqual(catalog.displayName(for: "acp_demo"), "ACP Demo")
        // Already listed, so the selection adds no placeholder.
        XCTAssertEqual(catalog.includingSelection("acp_demo").count, catalog.descriptors.count)
    }

    func testThePickerKeepsTheFilesOwnValueWhileTheBackendIsStopped() {
        // With no backend to ask, the floor is all this app has. A picker that
        // silently dropped the operator's configured runner would rewrite it on
        // the next change to something they never chose.
        let offered = RunnerCatalog.builtIn.includingSelection("acp_demo")

        XCTAssertEqual(offered.map(\.runnerKind), ["codex", "claude_code", "deepseek", "cursor", "acp_demo"])
        XCTAssertEqual(offered.last?.displayName, "Acp Demo")
    }

    func testAnUnknownRunnerIdIsReportedAsItselfRatherThanAsCodex() {
        var settings = ManagedBackendSettings()
        settings.runnerKind = "acp_demo"

        XCTAssertEqual(settings.resolvedRunnerKind, "acp_demo")
        // An absent key *is* the backend's own default, which is a different
        // statement from coercing an unrecognized one.
        XCTAssertEqual(ManagedBackendSettings().resolvedRunnerKind, "codex")
    }

    func testRuntimeReadinessDecodesAsUnknownUntilTheBackendHasProbed() throws {
        // Phase 6's fourth state. A backend that has spawned nothing omits the
        // field, and the client must read that as *unprobed* — defaulting it to
        // `false` would report a runner as broken for the sole reason that
        // nobody had asked about it yet.
        let body = Data("""
        {"runners":[
          {"runnerKind":"codex","displayName":"Codex","registered":true,"configured":true,"enabled":true},
          {"runnerKind":"claude_code","displayName":"Claude Code","registered":true,"configured":true,
           "enabled":true,"ready":true}
        ]}
        """.utf8)

        let response = try JSONDecoder().decode(RunnerCatalogResponse.self, from: body)
        let catalog = RunnerCatalog(descriptors: response.runners)

        XCTAssertNil(catalog.descriptor(for: "codex").ready)
        XCTAssertEqual(catalog.descriptor(for: "claude_code").ready, true)
        // A runner the catalog does not carry is unknown on every axis, never a
        // stand-in for another runner's answer.
        XCTAssertNil(catalog.descriptor(for: "acp_demo").ready)
    }

    func testSetupReadinessRunsNoBootstrapCheckForARunnerItDoesNotKnow() {
        let unknown = readiness(runnerKind: "acp_demo")
        let codex = readiness(runnerKind: "codex")

        // Codex's own check fires for Codex...
        XCTAssertTrue(codex.blockingItems.contains { $0.contains("Codex executable") })
        // ...and must not fire for a runner that is not Codex. Silence is the
        // honest answer: this app cannot say whether that runner is ready, and
        // asserting Codex's answer would be worse than saying nothing. Phase 6
        // replaced the switch that decided this with the absence of a bundled
        // bootstrap descriptor for that runner.
        XCTAssertFalse(unknown.blockingItems.contains { $0.contains("Codex") })
        XCTAssertFalse(unknown.blockingItems.contains { $0.contains("claude login") })
    }

    private func readiness(runnerKind: String) -> SetupReadiness {
        SetupReadiness(
            settings: .defaults,
            runnerKind: runnerKind,
            secrets: .empty,
            bootstrapDescriptor: RunnerBootstrapCatalog.descriptor(for: runnerKind),
            bootstrapStatuses: [:],
            connectionState: .reachable,
            hasLANURL: true
        )
    }
}
