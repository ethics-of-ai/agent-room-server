import XCTest
@testable import AgentRoomMac

/// The Keychain blob is one item shared across app versions, so Phase 6's
/// reshaping — typed per-runner fields to slots keyed by runner and slot id —
/// has to be readable both ways or an upgrade would silently lose the operator's
/// executable paths.
final class BackendSecretValuesTests: XCTestCase {
    func testDecodesThePreviousFlatShapeIntoSlots() throws {
        let legacy = Data("""
        {
          "authToken": "token",
          "codexExecutable": "/opt/homebrew/bin/codex",
          "codexArgs": "app-server,--listen,stdio://",
          "claudeCodeExecutable": "/Users/me/.local/bin/claude",
          "codexReasoningEffort": "high"
        }
        """.utf8)

        let secrets = try JSONDecoder().decode(BackendSecretValues.self, from: legacy)

        XCTAssertEqual(secrets.authToken, "token")
        XCTAssertEqual(secrets.slotValue(runnerKind: "codex", slotID: "executable"), "/opt/homebrew/bin/codex")
        XCTAssertEqual(secrets.slotValue(runnerKind: "codex", slotID: "arguments"), "app-server,--listen,stdio://")
        XCTAssertEqual(
            secrets.slotValue(runnerKind: "claude_code", slotID: "executable"),
            "/Users/me/.local/bin/claude"
        )
        // Still decode-only, and still cleared by the supervisor's one-time
        // migration into settings.json.
        XCTAssertEqual(secrets.legacyCodexReasoningEffort, "high")
    }

    func testRoundTripsSlotsAndDropsTheLegacyKeysOnTheNextSave() throws {
        var secrets = BackendSecretValues(authToken: "token")
        secrets.setSlotValue("/opt/homebrew/bin/codex", runnerKind: "codex", slotID: "executable")

        let encoded = try JSONEncoder().encode(secrets)
        let decoded = try JSONDecoder().decode(BackendSecretValues.self, from: encoded)

        XCTAssertEqual(decoded, secrets)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("codexExecutable"))
    }

    func testAStoredSlotWinsOverALegacyKeyLeftInTheBlob() throws {
        // A newer build has been authoritative since the first save after
        // upgrade, so a stale flat key must not overwrite what it wrote.
        let mixed = Data("""
        {
          "runnerSlots": {"codex": {"executable": "/current/codex"}},
          "codexExecutable": "/stale/codex"
        }
        """.utf8)

        let secrets = try JSONDecoder().decode(BackendSecretValues.self, from: mixed)

        XCTAssertEqual(secrets.slotValue(runnerKind: "codex", slotID: "executable"), "/current/codex")
    }

    func testEnvironmentCarriesOnlyNamesTheBundledDescriptorsDeclare() {
        var secrets = BackendSecretValues(authToken: "token")
        secrets.setSlotValue("/opt/homebrew/bin/codex", runnerKind: "codex", slotID: "executable")
        secrets.setSlotValue("/opt/homebrew/bin/dsh-jsonrpc-agent", runnerKind: "deepseek", slotID: "executable")
        secrets.setSlotValue("/Users/me/.dsh/agentroom/cordis.yml", runnerKind: "deepseek", slotID: "cordisConfig")
        secrets.setSlotValue("/opt/tools/acp", runnerKind: "acp_demo", slotID: "executable")

        let environment = secrets.environment()

        XCTAssertEqual(environment["AUTH_TOKEN"], "token")
        XCTAssertEqual(environment["CODEX_EXECUTABLE"], "/opt/homebrew/bin/codex")
        XCTAssertEqual(environment["DEEPSEEK_EXECUTABLE"], "/opt/homebrew/bin/dsh-jsonrpc-agent")
        // The `filePath` slot injects like every other one: the descriptor names
        // the variable, so a data file the backend hands a child needs no
        // separate mechanism to reach it.
        XCTAssertEqual(environment["DEEPSEEK_CORDIS_CONFIG"], "/Users/me/.dsh/agentroom/cordis.yml")
        // A value for a runner this build has no descriptor for is preserved in
        // the blob and reaches no child process: the descriptors are the
        // allowlist, so an unknown slot cannot name an environment variable.
        XCTAssertFalse(environment.values.contains("/opt/tools/acp"))
        XCTAssertEqual(secrets.slotValue(runnerKind: "acp_demo", slotID: "executable"), "/opt/tools/acp")
    }

    func testClearingASlotStopsItBeingInjected() {
        var secrets = BackendSecretValues()
        secrets.setSlotValue("/opt/homebrew/bin/codex", runnerKind: "codex", slotID: "executable")
        secrets.setSlotValue("   ", runnerKind: "codex", slotID: "executable")

        XCTAssertNil(secrets.slotValue(runnerKind: "codex", slotID: "executable"))
        XCTAssertNil(secrets.environment()["CODEX_EXECUTABLE"])
        // The runner's entry goes with its last value rather than lingering empty.
        XCTAssertTrue(secrets.runnerSlots.isEmpty)
    }

    func testEveryDeclaredEnvironmentNameIsStrippedFromTheInheritedEnvironment() {
        // A stale export must not shadow a Keychain-held value, so the strip list
        // and the injection list are derived from the same descriptors.
        for name in RunnerBootstrapCatalog.environmentNames {
            XCTAssertTrue(BackendSecretValues.managedEnvironmentNames.contains(name), "\(name) is not stripped")
        }
        XCTAssertTrue(BackendSecretValues.managedEnvironmentNames.contains("AUTH_TOKEN"))
    }
}
