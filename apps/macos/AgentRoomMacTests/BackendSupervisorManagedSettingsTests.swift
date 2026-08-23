import XCTest
@testable import AgentRoomMac

@MainActor
final class BackendSupervisorManagedSettingsTests: XCTestCase {
    func testSeedsTheSettingsFileFromLegacyPreferencesOnFirstRun() throws {
        let root = temporaryRootURL()
        let defaults = makeDefaults(rootURL: root)
        // What an install upgrading from the environment-injection era carries.
        defaults.set("claude_code", forKey: "runnerKind")
        defaults.set(true, forKey: "terminalEnabled")
        defaults.set(false, forKey: "sceneEngineEnabled")
        defaults.set(true, forKey: "codexWorkspaceNetworkAccessEnabled")

        let supervisor = makeSupervisor(defaults: defaults)

        XCTAssertNil(supervisor.managedSettingsIssue)
        XCTAssertEqual(supervisor.managedSettings.runnerKind, "claude_code")
        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)
        XCTAssertEqual(supervisor.managedSettings.sceneEngineEnabled, false)
        XCTAssertEqual(supervisor.managedSettings.codexWorkspaceNetworkAccess, true)
        XCTAssertEqual(
            supervisor.managedSettings.codexSandboxMode,
            ManagedBackendSettings.codexSandboxModeDangerFullAccess
        )
        // Seeded to disk, not just held in memory, so the backend reads the same
        // values on its next launch.
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        XCTAssertEqual(ManagedSettingsFileStore().read(at: settingsURL).settings, supervisor.managedSettings)
    }

    func testExistingSettingsFileWinsOverLegacyPreferences() throws {
        let root = temporaryRootURL()
        let defaults = makeDefaults(rootURL: root)
        defaults.set("claude_code", forKey: "runnerKind")
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"runnerKind":"codex"}"#.utf8).write(to: settingsURL)

        let supervisor = makeSupervisor(defaults: defaults)

        XCTAssertEqual(supervisor.managedSettings.runnerKind, "codex")
        XCTAssertEqual(supervisor.setupReadiness.resolvedRunnerKind, "codex")
    }

    func testMigratesLegacyReasoningEffortFromKeychainIntoManagedSettings() throws {
        let root = temporaryRootURL()
        let secretStore = StubBackendSecretStore()
        secretStore.values.legacyCodexReasoningEffort = " high "

        let supervisor = makeSupervisor(
            defaults: makeDefaults(rootURL: root),
            secretStore: secretStore
        )

        XCTAssertEqual(supervisor.managedSettings.codexReasoningEffort, "high")
        XCTAssertNil(supervisor.secrets.legacyCodexReasoningEffort)
        XCTAssertNil(secretStore.values.legacyCodexReasoningEffort)
        XCTAssertNil(secretStore.values.environment()["CODEX_REASONING_EFFORT"])
        let onDisk = ManagedSettingsFileStore().read(
            at: ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        )
        XCTAssertEqual(onDisk.settings.codexReasoningEffort, "high")
    }

    func testLegacyReasoningMigrationRefreshesTheFilesSchemaVersion() throws {
        let root = temporaryRootURL()
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // An absent schemaVersion is the flat version-1 document this migration
        // must convert whole when it adds the former Keychain preference.
        try Data(#"{"runnerKind":"codex"}"#.utf8).write(to: settingsURL)
        let secretStore = StubBackendSecretStore()
        secretStore.values.legacyCodexReasoningEffort = "high"

        let supervisor = makeSupervisor(
            defaults: makeDefaults(rootURL: root),
            secretStore: secretStore
        )

        XCTAssertEqual(supervisor.managedSettingsSchemaVersion, 2)
        XCTAssertFalse(supervisor.isManagedSettingsFileLegacy)
        XCTAssertTrue(supervisor.canWriteLegacyManagedSettingsFile)
        XCTAssertEqual(ManagedSettingsFileStore().read(at: settingsURL).schemaVersion, 2)
    }

    func testManagedReasoningEffortWinsOverLegacyKeychainValue() throws {
        let root = temporaryRootURL()
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        var settings = ManagedBackendSettings()
        settings.codexReasoningEffort = "low"
        try ManagedSettingsFileStore().write(settings, to: settingsURL)
        let secretStore = StubBackendSecretStore()
        secretStore.values.legacyCodexReasoningEffort = "high"

        let supervisor = makeSupervisor(
            defaults: makeDefaults(rootURL: root),
            secretStore: secretStore
        )

        XCTAssertEqual(supervisor.managedSettings.codexReasoningEffort, "low")
        XCTAssertNil(supervisor.secrets.legacyCodexReasoningEffort)
        XCTAssertNil(secretStore.values.legacyCodexReasoningEffort)
    }

    func testUpdatesWriteThroughToTheFileAndPreserveOtherKeys() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        // Stand-in for a key a paired client patched between Mac-side edits.
        try ManagedSettingsFileStore().update(at: settingsURL) { $0.codexModel = "gpt-5-codex" }

        supervisor.updateTerminalEnabled(true)

        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)
        let onDisk = ManagedSettingsFileStore().read(at: settingsURL).settings
        XCTAssertEqual(onDisk.terminalEnabled, true)
        XCTAssertEqual(onDisk.codexModel, "gpt-5-codex")
    }

    func testDescriptorBackedRunnerSelectionWritesAForwardRunnerID() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))

        supervisor.updateRunnerKind("acp_demo")

        XCTAssertEqual(supervisor.managedSettings.runnerKind, "acp_demo")
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        let onDisk = ManagedSettingsFileStore().read(at: settingsURL)
        XCTAssertNil(onDisk.issue)
        XCTAssertEqual(onDisk.settings.runnerKind, "acp_demo")
    }

    func testStoppingTheBackendRestoresTheOfflineRunnerFloor() async {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        supervisor.applyRunnerCatalog(
            RunnerCatalogResponse(runners: [
                RunnerDescriptor(
                    runnerKind: "acp_demo",
                    displayName: "ACP Demo",
                    registered: true,
                    configured: true,
                    enabled: true
                )
            ])
        )
        XCTAssertEqual(supervisor.runnerCatalog.descriptors.map(\.runnerKind), ["acp_demo"])

        supervisor.stopServer()
        await Task.yield()

        XCTAssertEqual(supervisor.runnerCatalog, .builtIn)
    }

    func testRefreshFromDiskAppliesAnExternalSettingsWrite() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try ManagedSettingsFileStore().update(at: settingsURL) {
            $0.runnerKind = "claude_code"
            $0.terminalEnabled = true
        }

        XCTAssertEqual(supervisor.managedSettings.runnerKind, "codex")

        supervisor.refreshManagedSettingsFromDisk()

        XCTAssertEqual(supervisor.managedSettings.runnerKind, "claude_code")
        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)
    }

    /// Phase 1 of docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md: a runner
    /// the backend registers brings its own managed settings, and this build has
    /// no field for them. They were already carried through a write untouched;
    /// what was missing is that they were invisible, so an `auto_allow` posture
    /// set from a paired client ran on this Mac with nothing here saying so.
    func testSettingsThisBuildCannotAddressAreSurfacedAndStillPreserved() throws {
        let root = temporaryRootURL()
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let document = """
        {"schemaVersion":2,"global":{"runnerKind":"codex"},\
        "runners":{"acp_gemini":{"permissionPolicy":"auto_allow"}}}
        """
        try Data(document.utf8).write(to: settingsURL)

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))

        XCTAssertNil(supervisor.managedSettingsIssue)
        XCTAssertEqual(
            supervisor.preservedManagedSettings.runners["acp_gemini"]?["permissionPolicy"],
            .string("auto_allow")
        )

        // Visibility must not cost the preservation it is reporting on.
        supervisor.updateTerminalEnabled(true)
        let rewritten = try String(contentsOf: settingsURL, encoding: .utf8)
        XCTAssertTrue(rewritten.contains("\"auto_allow\""))
        XCTAssertEqual(
            supervisor.preservedManagedSettings.runners["acp_gemini"]?["permissionPolicy"],
            .string("auto_allow")
        )
    }

    func testUnusableFileIsReportedAndNeverMergedInto() throws {
        let root = temporaryRootURL()
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let original = #"{"terminalEnabled":"yes"}"#
        try Data(original.utf8).write(to: settingsURL)

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        XCTAssertNotNil(supervisor.managedSettingsIssue)

        supervisor.updateTerminalEnabled(true)
        XCTAssertEqual(try String(contentsOf: settingsURL, encoding: .utf8), original)

        // Resetting is the deliberate way out, and it is the only overwrite of a
        // file this app could not read.
        supervisor.resetManagedSettingsFile()
        XCTAssertNil(supervisor.managedSettingsIssue)
        XCTAssertEqual(supervisor.managedSettings, ManagedBackendSettings())
    }

    func testRemoteSettingsAdminStaysAppStateRatherThanAManagedKey() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))

        supervisor.updateRemoteSettingsAdmin(true)

        XCTAssertTrue(supervisor.settings.remoteSettingsAdminEnabled)
        let contents = try String(
            contentsOf: ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path),
            encoding: .utf8
        )
        // In the file, a bearer-token holder could grant themselves the very
        // permission the switch withholds.
        XCTAssertFalse(contents.contains("remoteSettingsAdmin"))
    }

    // MARK: - Phase 5: the version-2 document and its way back

    func testSeededSettingsFileIsTheVersionTwoDocument() throws {
        let root = temporaryRootURL()

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))

        XCTAssertNil(supervisor.managedSettingsIssue)
        XCTAssertEqual(supervisor.managedSettingsSchemaVersion, 2)
        XCTAssertFalse(supervisor.isManagedSettingsFileLegacy)
        let written = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path))
            ) as? [String: Any]
        )
        XCTAssertEqual(written["schemaVersion"] as? Int, 2)
    }

    func testConvertingBackProducesTheFileAnOlderAgentRoomReads() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        supervisor.updateTerminalEnabled(true)

        supervisor.writeLegacyManagedSettingsFile()

        // Running an older build has to stay a supported step: it cannot be
        // taught to read the nested document, and it drops a file it cannot
        // parse *whole* — which would silently reset the operator's posture.
        XCTAssertTrue(supervisor.isManagedSettingsFileLegacy)
        XCTAssertFalse(supervisor.canWriteLegacyManagedSettingsFile)
        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)
        let written = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path))
            ) as? [String: Any]
        )
        XCTAssertNil(written["schemaVersion"])
        XCTAssertEqual(written["terminalEnabled"] as? Bool, true)

        // And a current AgentRoom converts it forward again on the next change,
        // so the round trip is not a one-way door either.
        supervisor.updateTerminalEnabled(false)
        XCTAssertEqual(supervisor.managedSettingsSchemaVersion, 2)
    }

    /// The other half of "running an older build is a supported step": a posture
    /// that build cannot hold must be refused *before* it is written, not
    /// converted into a file it drops whole. `runnerKind` is the one key where
    /// that applies — an unknown runner's settings namespace is preserved and
    /// ignored, but an unknown value for a known key is not.
    func testConvertingBackIsRefusedWhileTheDefaultRunnerPredatesTheOlderBuild() throws {
        let root = temporaryRootURL()
        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        supervisor.updateTerminalEnabled(true)
        supervisor.updateRunnerKind("deepseek")

        XCTAssertEqual(supervisor.runnerKindBlockingLegacyManagedSettingsFile, "deepseek")
        XCTAssertFalse(supervisor.canWriteLegacyManagedSettingsFile)

        supervisor.writeLegacyManagedSettingsFile()

        // Nothing was written: the file is still the nested document, and the
        // trust setting it carries is still there to convert once the operator
        // picks a runner the older build knows.
        XCTAssertEqual(supervisor.managedSettingsSchemaVersion, 2)
        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)

        supervisor.updateRunnerKind("codex")
        XCTAssertNil(supervisor.runnerKindBlockingLegacyManagedSettingsFile)
        XCTAssertTrue(supervisor.canWriteLegacyManagedSettingsFile)
        supervisor.writeLegacyManagedSettingsFile()
        XCTAssertTrue(supervisor.isManagedSettingsFileLegacy)
        XCTAssertEqual(supervisor.managedSettings.terminalEnabled, true)
    }

    /// A file may already be flat while carrying a runner value an older build
    /// rejects. The Advanced pane must describe that blocker rather than claim
    /// the file is rollback-safe merely because its shape is already version 1.
    func testLegacyFileStillReportsAnIncompatibleDefaultRunnerAsTheRollbackBlocker() throws {
        let root = temporaryRootURL()
        let settingsURL = ManagedSettingsFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"runnerKind":"deepseek"}"#.utf8).write(to: settingsURL)

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))

        XCTAssertTrue(supervisor.isManagedSettingsFileLegacy)
        XCTAssertEqual(supervisor.runnerKindBlockingLegacyManagedSettingsFile, "deepseek")
        XCTAssertFalse(supervisor.canWriteLegacyManagedSettingsFile)
    }

    func testAdvancedPaneNamesTheRollbackBlockerBeforeCallingAFileAlreadyLegacy() throws {
        let paneURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("AgentRoomMac/Views/Settings/AdvancedSettingsPane.swift")
        let source = try String(contentsOf: paneURL, encoding: .utf8)
        let blockerCheck = try XCTUnwrap(
            source.range(of: "if let runnerKind = supervisor.runnerKindBlockingLegacyManagedSettingsFile")
        )
        let legacyCheck = try XCTUnwrap(
            source.range(of: "if supervisor.isManagedSettingsFileLegacy")
        )

        XCTAssertLessThan(
            source.distance(from: source.startIndex, to: blockerCheck.lowerBound),
            source.distance(from: source.startIndex, to: legacyCheck.lowerBound)
        )
        XCTAssertTrue(source.contains("The default runner is \\(displayName), which an older AgentRoom does not know."))
    }

    func testTheOfflineRunnerPickerPrefersTheCatalogTheBackendLeftBehind() throws {
        let root = temporaryRootURL()
        let catalogURL = RunnerCatalogFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: catalogURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"schemaVersion":1,"runners":[{"runnerKind":"acp_demo","displayName":"ACP Demo"}]}"#.utf8)
            .write(to: catalogURL)

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        // The transition every offline path takes: no backend answering, so the
        // picker falls back — to the catalog a backend that started successfully
        // left behind, rather than to a floor that cannot grow.
        supervisor.applyRunnerCatalog(nil)

        XCTAssertEqual(supervisor.runnerCatalog.descriptors.map(\.runnerKind), ["acp_demo"])
    }

    func testTheOfflineRunnerPickerFallsBackToTheBundleForACatalogItCannotUse() throws {
        let root = temporaryRootURL()
        let catalogURL = RunnerCatalogFileStore.fileURL(forAgentRoomHomePath: root.path)
        try FileManager.default.createDirectory(
            at: catalogURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // Newer than this release understands: the bundle is a better answer
        // than guessing at a shape this app was not built for.
        try Data(#"{"schemaVersion":9,"runners":[{"runnerKind":"acp_demo","displayName":"ACP Demo"}]}"#.utf8)
            .write(to: catalogURL)

        let supervisor = makeSupervisor(defaults: makeDefaults(rootURL: root))
        supervisor.applyRunnerCatalog(nil)

        XCTAssertEqual(supervisor.runnerCatalog, .builtIn)
    }

    private func temporaryRootURL() -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func makeDefaults(rootURL: URL) -> UserDefaults {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(rootURL.path, forKey: "agentRoomHomePath")
        defaults.set(rootURL.appendingPathComponent("workspaces", isDirectory: true).path, forKey: "workspacePath")
        defaults.set(rootURL.appendingPathComponent("state", isDirectory: true).path, forKey: "statePath")
        return defaults
    }

    private func makeSupervisor(
        defaults: UserDefaults,
        secretStore: StubBackendSecretStore = StubBackendSecretStore()
    ) -> BackendSupervisor {
        BackendSupervisor(
            defaults: defaults,
            secretStore: secretStore,
            bootstrapProber: RunnerBootstrapTestSupport.prober(),
            launchAtLoginController: StubLaunchAtLoginController()
        )
    }
}

private final class StubBackendSecretStore: BackendSecretStore {
    var values: BackendSecretValues = .empty

    func loadSecrets() throws -> BackendSecretValues {
        values
    }

    func saveSecrets(_ values: BackendSecretValues) throws {
        self.values = values
    }
}

private struct StubLaunchAtLoginController: LaunchAtLoginManaging {
    var isEnabled = false

    func setEnabled(_ isEnabled: Bool) throws {}
}
