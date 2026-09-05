import XCTest
@testable import AgentRoomMac

final class ManagedSettingsFileStoreTests: XCTestCase {
    private let store = ManagedSettingsFileStore()

    func testReadReportsNoIssueWhenFileIsAbsent() {
        let read = store.read(at: temporaryFileURL())

        XCTAssertNil(read.issue)
        XCTAssertEqual(read.settings, ManagedBackendSettings())
    }

    func testReadRejectsAnOutOfRangeSchemaVersionWithoutTrapping() {
        let read = store.read(at: temporaryFileURL(writing: #"{"schemaVersion":1e100}"#))

        XCTAssertEqual(read.issue, "has an unexpected value for schemaVersion")
        XCTAssertNil(read.unsupportedSchemaVersion)
        XCTAssertEqual(read.settings, ManagedBackendSettings())
    }

    func testWriteOmitsUnsetKeysRatherThanWritingNull() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.terminalEnabled = true

        try store.write(settings, to: url)

        // The backend's schema is strict and its optional keys reject an explicit
        // null, so writing one would make it drop the *whole* file back to
        // defaults — silently undoing every other setting in it.
        let contents = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(contents.contains("null"))
        XCTAssertFalse(contents.contains("model"))
        XCTAssertTrue(contents.contains("\"terminalEnabled\""))
    }

    func testWriteRoundTrips() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "claude_code"
        settings.terminalEnabled = true
        settings.terminalMaxSessions = 12

        try store.write(settings, to: url)
        XCTAssertEqual(store.read(at: url).settings, settings)
    }

    func testReadRejectsUnknownKeysLikeTheBackendSchema() throws {
        let url = temporaryFileURL()
        let original = #"{"runnerKind":"codex","somethingElse":true}"#
        try Data(original.utf8).write(to: url)

        let read = store.read(at: url)

        XCTAssertNotNil(read.issue)
        XCTAssertEqual(read.settings, ManagedBackendSettings())
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original)
    }

    func testReadDropsBackendInvalidValuesWhole() throws {
        for contents in [
            #"{"codexReasoningEffort":"extreme"}"#,
            #"{"terminalMaxSessions":100}"#,
            #"{"gitCommandTimeoutMs":0}"#,
            #"{"gitNetworkTimeoutMs":9007199254740992}"#,
            #"{"claudeCodePermissionMode":"allowAll"}"#,
            #"{"codexSandboxMode":"unrestricted"}"#,
            #"{"codexModel":"not a model!"}"#,
            #"{"codexModel":null}"#
        ] {
            let url = temporaryFileURL()
            try Data(contents.utf8).write(to: url)

            let read = store.read(at: url)

            XCTAssertNotNil(read.issue, contents)
            XCTAssertEqual(read.settings, ManagedBackendSettings(), contents)
        }
    }

    func testReadAndUpdatePreserveARunnerIDThisAppPredates() throws {
        let url = temporaryFileURL(writing: #"{"runnerKind":"acp_demo"}"#)

        let read = store.read(at: url)

        XCTAssertNil(read.issue)
        XCTAssertEqual(read.settings.runnerKind, "acp_demo")

        try store.update(at: url) { $0.terminalEnabled = true }

        let written = store.read(at: url)
        XCTAssertNil(written.issue)
        XCTAssertEqual(written.settings.runnerKind, "acp_demo")
        XCTAssertEqual(written.settings.terminalEnabled, true)
    }

    func testReadNormalizesIdentifiersLikeTheBackendSchema() throws {
        let url = temporaryFileURL()
        try Data(#"{"codexModel":"  gpt-5-codex  ","codexServiceTier":" fast "}"#.utf8).write(to: url)

        let read = store.read(at: url)

        XCTAssertNil(read.issue)
        XCTAssertEqual(read.settings.codexModel, "gpt-5-codex")
        XCTAssertEqual(read.settings.codexServiceTier, "fast")
    }

    func testUpdatePreservesKeysThisAppNeverRenders() throws {
        let url = temporaryFileURL()
        // Stand-in for a key a paired client patched: the Mac's own controls do
        // not render it, and a Mac-side toggle must not drop it.
        try Data(#"{"codexModel":"gpt-5-codex","terminalEnabled":false}"#.utf8).write(to: url)

        let updated = try store.update(at: url) { settings in
            settings.terminalEnabled = true
        }

        XCTAssertEqual(updated.codexModel, "gpt-5-codex")
        XCTAssertEqual(updated.terminalEnabled, true)
        XCTAssertEqual(store.read(at: url).settings.codexModel, "gpt-5-codex")
    }

    func testUpdateRefusesToMergeIntoAnUnusableFileAndLeavesItAlone() throws {
        let url = temporaryFileURL()
        let original = #"{"codexReasoningEffort":"extreme"}"#
        try Data(original.utf8).write(to: url)

        let read = store.read(at: url)
        XCTAssertNotNil(read.issue)
        XCTAssertEqual(read.settings, ManagedBackendSettings())

        XCTAssertThrowsError(try store.update(at: url) { $0.terminalEnabled = true }) { error in
            guard case ManagedSettingsFileStoreError.unusableFile = error else {
                return XCTFail("Expected an unusableFile error, got \(error)")
            }
        }
        // Merging would have dropped whatever else the operator put in the file,
        // so the bytes on disk must be untouched.
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original)
    }

    func testUpdateSkipsTheWriteWhenNothingChanges() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.sceneEngineEnabled = true
        try store.write(settings, to: url)
        let writtenAt = try modificationDate(of: url)

        try store.update(at: url) { $0.sceneEngineEnabled = true }

        XCTAssertEqual(try modificationDate(of: url), writtenAt)
    }

    func testGitNetworkAccessWritesBothHonestKeys() throws {
        let url = temporaryFileURL()

        let enabled = try store.update(at: url) { $0.setCodexGitNetworkAccess(true) }
        XCTAssertEqual(enabled.codexWorkspaceNetworkAccess, true)
        XCTAssertEqual(enabled.codexSandboxMode, ManagedBackendSettings.codexSandboxModeDangerFullAccess)

        let disabled = try store.update(at: url) { $0.setCodexGitNetworkAccess(false) }
        XCTAssertEqual(disabled.codexWorkspaceNetworkAccess, false)
        XCTAssertEqual(disabled.codexSandboxMode, ManagedBackendSettings.codexSandboxModeWorkspaceWrite)
    }

    // MARK: - The version-2 document
    //
    // docs/engineering/RUNNERS.md: the nested
    // document is the shape this app writes, version 1 is still read and
    // migrated whole by the next write, and converting back is the deliberate
    // rollback path — an older AgentRoom cannot be taught to read the new shape,
    // and both readers drop a file they cannot parse *whole*.

    func testWriteProducesTheVersionTwoDocument() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "claude_code"
        settings.terminalEnabled = true
        settings.codexSandboxMode = ManagedBackendSettings.codexSandboxModeWorkspaceWrite

        try store.write(settings, to: url)

        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(written["schemaVersion"] as? Int, 2)
        XCTAssertEqual((written["global"] as? [String: Any])?["runnerKind"] as? String, "claude_code")
        let runners = try XCTUnwrap(written["runners"] as? [String: Any])
        XCTAssertEqual((runners["codex"] as? [String: Any])?["sandboxMode"] as? String, "workspace-write")
        XCTAssertEqual(store.read(at: url).settings, settings)
    }

    func testUpdateMigratesAVersionOneFileWhole() throws {
        let url = temporaryFileURL(writing: #"{"runnerKind":"codex","codexModel":"gpt-5-codex"}"#)

        try store.update(at: url) { $0.terminalEnabled = true }

        // Whole-file, in one write: two addresses for one setting is a
        // precedence question nobody should have to answer, so there is no
        // prolonged dual-shape state.
        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(written["schemaVersion"] as? Int, 2)
        XCTAssertNil(written["codexModel"])
        XCTAssertEqual((written["runners"] as? [String: Any])?["codex"] as? [String: String], ["model": "gpt-5-codex"])
        XCTAssertEqual((written["global"] as? [String: Any])?["terminalEnabled"] as? Bool, true)
    }

    func testUpdatePreservesSectionsThisAppCannotAddress() throws {
        let url = temporaryFileURL(
            writing: #"{"schemaVersion":2,"global":{"runnerKind":"codex","futureFlag":true},"#
                + #""runners":{"codex":{"futureField":1},"acp_demo":{"model":"x"}}}"#
        )

        try store.update(at: url) { $0.terminalEnabled = true }

        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        // Value-for-value: a toggle in these panes must not be the reason a
        // section this app cannot address disappears from the operator's file.
        XCTAssertEqual((written["global"] as? [String: Any])?["futureFlag"] as? Bool, true)
        let runners = try XCTUnwrap(written["runners"] as? [String: Any])
        XCTAssertEqual((runners["codex"] as? [String: Any])?["futureField"] as? Int, 1)
        XCTAssertEqual((runners["acp_demo"] as? [String: Any])?["model"] as? String, "x")
    }

    func testAVersionOneSectionDoesNotBecomeLiveThroughTheMigration() throws {
        let url = temporaryFileURL(
            writing: #"{"runnerKind":"codex","runners":{"codex":{"sandboxMode":"danger-full-access","futureField":1}}}"#
        )

        // In a version-1 document that section was never applied, so carrying a
        // *known* address across the migration would silently activate a trust
        // value the running backend had been ignoring.
        XCTAssertNil(store.read(at: url).settings.codexSandboxMode)

        try store.update(at: url) { $0.terminalEnabled = true }

        XCTAssertNil(store.read(at: url).settings.codexSandboxMode)
        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual((written["runners"] as? [String: Any])?["codex"] as? [String: Int], ["futureField": 1])
    }

    func testVersionTwoWithALegacyKeyReadsAsMalformedRatherThanNewer() throws {
        let read = store.read(
            at: temporaryFileURL(writing: #"{"schemaVersion":2,"terminalEnabled":true,"global":{}}"#)
        )

        XCTAssertEqual(read.issue, "declares schema version 2 alongside the legacy key terminalEnabled")
        XCTAssertNil(read.unsupportedSchemaVersion)
    }

    func testVersionTwoRequiresEveryRunnerNamespaceToBeAnObject() throws {
        let read = store.read(
            at: temporaryFileURL(writing: #"{"schemaVersion":2,"runners":{"codex":"workspace-write"}}"#)
        )

        XCTAssertEqual(read.issue, "has an unexpected value for runners.codex")
        XCTAssertNil(read.unsupportedSchemaVersion)
    }

    func testAGenuinelyNewerSchemaReadsAsNewerRatherThanBroken() throws {
        let read = store.read(at: temporaryFileURL(writing: #"{"schemaVersion":7,"global":{}}"#))

        // Unusable either way, but the two states have different repairs —
        // update AgentRoom, versus reset the file — so they must stay
        // distinguishable. Resetting a newer file would destroy a posture the
        // operator did author.
        XCTAssertNotNil(read.issue)
        XCTAssertEqual(read.unsupportedSchemaVersion, 7)
        XCTAssertEqual(read.settings, ManagedBackendSettings())
        XCTAssertNil(store.read(at: temporaryFileURL(writing: "{ broken")).unsupportedSchemaVersion)
    }

    func testUpdateRefusesANewerSchemaAndLeavesTheBytesAlone() throws {
        let original = #"{"schemaVersion":7,"global":{"terminalEnabled":true}}"#
        let url = temporaryFileURL(writing: original)

        XCTAssertThrowsError(try store.update(at: url) { $0.terminalEnabled = false }) { error in
            guard case ManagedSettingsFileStoreError.unsupportedSchema(let version) = error else {
                return XCTFail("Expected an unsupportedSchema error, got \(error)")
            }
            XCTAssertEqual(version, 7)
        }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original)
    }

    func testWriteRefusesToProduceASchemaThisReleaseCannotApply() throws {
        let url = temporaryFileURL()

        XCTAssertThrowsError(try store.write(ManagedBackendSettings(), to: url, schemaVersion: 3)) { error in
            guard case ManagedSettingsFileStoreError.unsupportedSchema = error else {
                return XCTFail("Expected an unsupportedSchema error, got \(error)")
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testRejectsASectionThatIsNotAnObject() throws {
        let read = store.read(at: temporaryFileURL(writing: #"{"runners":[]}"#))

        XCTAssertEqual(read.issue, "has an unexpected value for runners")
        XCTAssertNil(read.unsupportedSchemaVersion)
    }

    // MARK: - Legacy rollback

    func testLegacyConversionProducesTheDocumentAnOlderAgentRoomReads() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "claude_code"
        settings.codexSandboxMode = ManagedBackendSettings.codexSandboxModeDangerFullAccess
        try store.write(settings, to: url)

        try store.writeLegacyDocument(at: url)

        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        // No `schemaVersion`: an absent version *is* version 1, and stamping it
        // would produce a file the older reader calls malformed — the opposite
        // of a rollback.
        XCTAssertNil(written["schemaVersion"])
        XCTAssertEqual(written["runnerKind"] as? String, "claude_code")
        XCTAssertEqual(written["codexSandboxMode"] as? String, "danger-full-access")
        XCTAssertEqual(store.read(at: url).settings, settings)
        XCTAssertEqual(store.read(at: url).schemaVersion, 1)
    }

    func testLegacyConversionCarriesASectionItCannotAddress() throws {
        let url = temporaryFileURL(writing: #"{"schemaVersion":2,"runners":{"acp_demo":{"model":"x"}}}"#)

        try store.writeLegacyDocument(at: url)

        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        // A version-1 document cannot *address* a runner namespace, but the
        // version-1 reader tolerates and preserves one, which is what makes
        // the downgrade reversible.
        let runners = try XCTUnwrap(written["runners"] as? [String: Any])
        XCTAssertEqual((runners["acp_demo"] as? [String: Any])?["model"] as? String, "x")
    }

    func testLegacyConversionRefusesAFileItCouldNotRead() throws {
        let original = "{ broken"
        let url = temporaryFileURL(writing: original)

        XCTAssertThrowsError(try store.writeLegacyDocument(at: url)) { error in
            guard case ManagedSettingsFileStoreError.unusableFile = error else {
                return XCTFail("Expected an unusableFile error, got \(error)")
            }
        }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original)
    }

    /// The rollout gate's remaining hazard, and the reason the conversion has a
    /// guard rather than only a document shape. An unknown `runners.<id>`
    /// namespace is preserved-but-never-applied by an older reader, so a third
    /// runner's settings survive a downgrade — but `runnerKind` is a **known**
    /// key there, and a malformed known value makes the whole file unusable,
    /// dropping every trust setting in it. See
    /// `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`.
    func testLegacyConversionRefusesARunnerAnOlderAgentRoomDoesNotKnow() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "deepseek"
        settings.terminalEnabled = true
        try store.write(settings, to: url)

        XCTAssertThrowsError(try store.writeLegacyDocument(at: url)) { error in
            guard case ManagedSettingsFileStoreError.unconvertibleRunnerKind(let runnerKind) = error else {
                return XCTFail("Expected an unconvertibleRunnerKind error, got \(error)")
            }
            XCTAssertEqual(runnerKind, "deepseek")
        }
        // Refused whole: the operator's posture is still here, in the shape it
        // was in, so changing the default runner and converting is still open.
        XCTAssertEqual(store.read(at: url).schemaVersion, 2)
        XCTAssertEqual(store.read(at: url).settings, settings)
    }

    /// The same rule, for the value it exists to catch second: an operator's own
    /// configured ACP adapter is a runner id no shipped older build ever knew.
    func testLegacyConversionRefusesAConfiguredAdapterAsTheDefaultRunner() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "acp_demo"
        try store.write(settings, to: url)

        XCTAssertThrowsError(try store.writeLegacyDocument(at: url)) { error in
            guard case ManagedSettingsFileStoreError.unconvertibleRunnerKind = error else {
                return XCTFail("Expected an unconvertibleRunnerKind error, got \(error)")
            }
        }
    }

    /// An absent key is not a lost setting: the older build applies its own
    /// default, which is what it would have done anyway.
    func testLegacyConversionAllowsAFileThatNamesNoDefaultRunner() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.terminalEnabled = true
        try store.write(settings, to: url)

        try store.writeLegacyDocument(at: url)

        XCTAssertEqual(store.read(at: url).schemaVersion, 1)
        XCTAssertEqual(store.read(at: url).settings.terminalEnabled, true)
    }

    func testTheRoundTripThroughBothShapesKeepsEverySetting() throws {
        let url = temporaryFileURL()
        var settings = ManagedBackendSettings()
        settings.runnerKind = "claude_code"
        settings.artifactsEnabled = false
        settings.languageCatalogEnabled = false
        settings.sceneEngineEnabled = false
        settings.gitCommandTimeoutMs = 45_000
        settings.gitNetworkTimeoutMs = 90_000
        settings.terminalEnabled = true
        settings.terminalMaxSessions = 12
        settings.codexModel = "gpt-5-codex"
        settings.codexReasoningEffort = "high"
        settings.codexServiceTier = "fast"
        settings.codexApprovalPolicy = "never"
        settings.codexSandboxMode = ManagedBackendSettings.codexSandboxModeDangerFullAccess
        settings.codexWorkspaceNetworkAccess = true
        settings.claudeCodeModel = "claude-fable-5"
        settings.claudeCodeReasoningEffort = "xhigh"
        settings.claudeCodePermissionMode = "acceptEdits"
        settings.claudeCodeLoadWorkspaceSkills = false
        settings.claudeCodeInheritProviderAuth = true

        try store.write(settings, to: url)
        XCTAssertEqual(store.read(at: url).settings, settings)

        try store.writeLegacyDocument(at: url)
        XCTAssertEqual(store.read(at: url).settings, settings)

        try store.update(at: url) { $0.terminalMaxSessions = 13 }
        XCTAssertEqual(store.read(at: url).schemaVersion, 2)
        XCTAssertEqual(store.read(at: url).settings.claudeCodePermissionMode, "acceptEdits")
    }

    func testFileURLMatchesTheBackendResolvedPath() {
        XCTAssertEqual(
            ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: "/tmp/AgentRoom").path,
            "/tmp/AgentRoom/config/settings.json"
        )
    }

    private func temporaryFileURL() -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("settings.json")
    }

    private func temporaryFileURL(writing contents: String) -> URL {
        let url = temporaryFileURL()
        try? Data(contents.utf8).write(to: url)
        return url
    }

    private func modificationDate(of url: URL) throws -> Date {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)
    }
}
