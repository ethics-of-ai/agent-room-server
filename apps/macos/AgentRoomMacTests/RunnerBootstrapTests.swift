import XCTest
import Security
@testable import AgentRoomMac

/// The Mac half of Phase 6's split readiness
/// (`docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`): a bundled, trusted
/// bootstrap contract, executed by one prober that knows probe *kinds* and never
/// which runner it is looking at.
final class RunnerBootstrapTests: XCTestCase {
    func testExecutableProbeKeepsAStoredPathThatStillResolves() throws {
        let installed = temporaryURL(named: "codex")
        try RunnerBootstrapTestSupport.makeExecutableFile(at: installed)
        let descriptor = RunnerBootstrapTestSupport.descriptor("codex")
        let probe = try XCTUnwrap(descriptor.probe("executable"))

        let outcome = RunnerBootstrapTestSupport.prober().run(probe, of: descriptor) { _ in installed.path }

        XCTAssertEqual(outcome.status, .satisfied(detail: installed.path))
        // Nothing to persist: the operator's value is already the answer.
        XCTAssertNil(outcome.resolvedSlot)
        XCTAssertEqual(probe.message(for: outcome.status), "Codex is configured at \(installed.path).")
    }

    func testExecutableProbeReplacesAStoredPathThatNoLongerResolves() throws {
        let installed = temporaryURL(named: "codex")
        try RunnerBootstrapTestSupport.makeExecutableFile(at: installed)
        let descriptor = RunnerBootstrapTestSupport.descriptor("codex")
        let probe = try XCTUnwrap(descriptor.probe("executable"))
        let prober = RunnerBootstrapTestSupport.prober(codexCandidates: [installed])

        // A CLI that was moved or uninstalled must not stay pinned.
        let outcome = prober.run(probe, of: descriptor) { _ in "/nonexistent/codex" }

        XCTAssertEqual(outcome.status, .detected(detail: installed.path))
        XCTAssertEqual(outcome.resolvedSlot, .init(slotID: "executable", path: installed.path))
    }

    func testExecutableProbeReportsAbsenceWhenNothingIsInstalled() throws {
        let descriptor = RunnerBootstrapTestSupport.descriptor("codex")
        let probe = try XCTUnwrap(descriptor.probe("executable"))

        let outcome = RunnerBootstrapTestSupport.prober().run(probe, of: descriptor) { _ in nil }

        XCTAssertEqual(outcome.status, .absent)
        XCTAssertEqual(
            probe.blockingItem(for: outcome.status),
            "Install Codex CLI, then rerun the check."
        )
    }

    func testDeepSeekExecutableProbeSavesTheDetectedSDKRuntime() throws {
        // `dsh-jsonrpc-agent`, never `dsh`: the launcher boots profiles and
        // serves no SDK protocol, so detecting it would save a path that can
        // never complete a handshake and report a runner that is not ready.
        let installed = temporaryURL(named: "dsh-jsonrpc-agent")
        try RunnerBootstrapTestSupport.makeExecutableFile(at: installed)
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        let probe = try XCTUnwrap(descriptor.probe("executable"))

        let outcome = RunnerBootstrapTestSupport.prober(deepseekCandidates: [installed])
            .run(probe, of: descriptor) { _ in nil }

        XCTAssertEqual(outcome.status, .detected(detail: installed.path))
        XCTAssertEqual(outcome.resolvedSlot, .init(slotID: "executable", path: installed.path))
        XCTAssertEqual(descriptor.slot("arguments")?.environmentName, "DEEPSEEK_ARGS")
    }

    func testDeepSeekExecutableProbeReplacesThePreviouslySavedLauncher() throws {
        let runtime = temporaryURL(named: "dsh-jsonrpc-agent")
        let launcher = runtime.deletingLastPathComponent().appendingPathComponent("dsh")
        try RunnerBootstrapTestSupport.makeExecutableFile(at: runtime)
        try RunnerBootstrapTestSupport.makeExecutableFile(at: launcher)
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        let probe = try XCTUnwrap(descriptor.probe("executable"))
        let prober = RunnerBootstrapProber(
            environment: ["PATH": runtime.deletingLastPathComponent().path],
            keychain: KeychainPresenceProbe(lookup: { _ in errSecItemNotFound })
        )

        let outcome = prober.run(probe, of: descriptor) { _ in launcher.path }

        XCTAssertEqual(outcome.status, .detected(detail: runtime.path))
        XCTAssertEqual(outcome.resolvedSlot, .init(slotID: "executable", path: runtime.path))
    }

    func testDeepSeekDeclaresTheCompositionItsRuntimeRefusesToStartWithout() throws {
        // The runtime takes its Cordis composition from $DSH_CORDIS_CONFIG or an
        // argv positional and exits nonzero with neither, so the Mac has to be
        // able to hold that path — a build that could not would leave this
        // runner unconfigurable from the app it is set up in.
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        let slot = try XCTUnwrap(descriptor.slot("cordisConfig"))

        XCTAssertEqual(slot.kind, .filePath)
        XCTAssertEqual(slot.environmentName, "DEEPSEEK_CORDIS_CONFIG")
        // A data file the backend hands the child, never one it spawns. Its
        // required probe validates only the operator's chosen path and searches
        // nowhere, so it cannot turn this slot into executable authority.
        let probe = try XCTUnwrap(descriptor.probe("cordisConfig"))
        XCTAssertEqual(probe.resolvedSlotID, slot.id)
        XCTAssertEqual(probe.requirement, .required)
    }

    func testDeepSeekCompositionProbeRequiresAReadableAbsoluteFile() throws {
        let composition = temporaryURL(named: "cordis.yml")
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        let probe = try XCTUnwrap(descriptor.probe("cordisConfig"))
        let prober = RunnerBootstrapTestSupport.prober()

        let missing = prober.run(probe, of: descriptor) { _ in nil }
        let relative = prober.run(probe, of: descriptor) { _ in "config/cordis.yml" }

        XCTAssertEqual(missing.status, .absent)
        XCTAssertEqual(relative.status, .absent)
        XCTAssertEqual(
            probe.blockingItem(for: missing.status),
            "Choose an existing DeepSeek Harness Cordis composition, then rerun the check."
        )

        try FileManager.default.createDirectory(
            at: composition.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "plugins: []\n".write(to: composition, atomically: true, encoding: .utf8)

        let configured = prober.run(probe, of: descriptor) { _ in composition.path }

        XCTAssertEqual(configured.status, .satisfied(detail: composition.path))
        XCTAssertNil(configured.resolvedSlot)
    }

    func testKeychainProbeReadsPresenceAndNeverTheCredential() throws {
        let descriptor = RunnerBootstrapTestSupport.descriptor("claude_code")
        let probe = try XCTUnwrap(descriptor.probe("signIn"))

        let signedIn = RunnerBootstrapTestSupport.prober(keychainStatus: errSecSuccess)
            .run(probe, of: descriptor) { _ in nil }
        let signedOut = RunnerBootstrapTestSupport.prober(keychainStatus: errSecItemNotFound)
            .run(probe, of: descriptor) { _ in nil }
        let failed = RunnerBootstrapTestSupport.prober(keychainStatus: errSecAuthFailed)
            .run(probe, of: descriptor) { _ in nil }

        XCTAssertEqual(signedIn.status, .satisfied(detail: nil))
        XCTAssertEqual(signedOut.status, .absent)
        XCTAssertEqual(
            failed.status,
            .failed(message: "Could not verify Claude Code sign-in (Keychain status \(errSecAuthFailed)).")
        )
        // Presence only: the probe carries a status code, never item data.
        XCTAssertNil(signedIn.status.resolvedPath)
    }

    func testAnInformationalPrerequisiteNeverBlocksSetup() throws {
        let descriptor = RunnerBootstrapTestSupport.descriptor("claude_code")
        let signIn = try XCTUnwrap(descriptor.probe("signIn"))
        let executable = try XCTUnwrap(descriptor.probe("executable"))

        // With no local claude the Agent SDK still runs turns with the CLI it
        // bundles, so the only cost is a possibly-stale model list.
        XCTAssertEqual(executable.requirement, .informational)
        XCTAssertNil(executable.blockingItem(for: .absent))
        XCTAssertEqual(
            signIn.blockingItem(for: .absent),
            "Sign in with claude login so Claude Code turns can authenticate."
        )
    }

    func testEveryBundledDescriptorDeclaresAnEnvironmentNameForEverySlot() {
        // The launch environment is built by walking these descriptors, so a slot
        // without a name would be a value the operator could set and the backend
        // would never see.
        for descriptor in RunnerBootstrapCatalog.builtIn {
            XCTAssertFalse(descriptor.runnerKind.isEmpty)
            for slot in descriptor.slots {
                XCTAssertFalse(slot.environmentName.isEmpty)
            }
            for probe in descriptor.probes {
                // A probe that resolves a slot must resolve one this descriptor
                // actually declares, or the value would be stored where nothing
                // reads it.
                if let slotID = probe.resolvedSlotID {
                    XCTAssertNotNil(descriptor.slot(slotID))
                }
            }
        }
    }

    func testASecretSlotIsRedactedOutOfExportedDiagnostics() {
        // The redactor walks *stored values* rather than a list of fields, so a
        // credential slot is covered the moment it exists. This pins that: the
        // first slot holding a provider secret must not be the one that proves
        // the breadth rule was load-bearing all along.
        var secrets = BackendSecretValues.empty
        secrets.setSlotValue("fixture-provider-secret", runnerKind: "deepseek", slotID: "apiKey")
        let redacted = DiagnosticsTextRedactor(secrets: secrets)
            .redact("child env: DEEPSEEK_API_KEY=fixture-provider-secret DSH_CWD=/tmp")

        XCTAssertFalse(redacted.contains("fixture-provider-secret"))
        XCTAssertTrue(redacted.contains("<redacted>"))
    }

    func testDeepSeekHoldsItsProviderKeyAsAMaskedSlotThatIsNeverProbed() {
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        guard let apiKey = descriptor.slot("apiKey") else {
            return XCTFail("DeepSeek is expected to hold its provider key")
        }

        XCTAssertEqual(apiKey.kind, .secret)
        XCTAssertEqual(apiKey.environmentName, "DEEPSEEK_API_KEY")
        // Nothing can check a key without spending it, so it carries no probe —
        // a Check button that could only ever say "saved" would imply a
        // validation this app cannot perform.
        XCTAssertNil(descriptor.probes.first { $0.resolvedSlotID == "apiKey" })
    }

    // MARK: - Source checkout

    func testSourceCheckoutResolvesInterpreterEntrypointAndComposition() throws {
        let root = try makeCheckout(entrypointBuilt: true, composition: true)
        let node = try makeExecutable(named: "node")

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertEqual(resolution.problems, [])
        XCTAssertEqual(
            resolution.slots.map(\.slotID).sorted(),
            ["arguments", "cordisConfig", "executable"]
        )
        XCTAssertEqual(resolution.slots.first { $0.slotID == "executable" }?.value, node.path)
        XCTAssertEqual(
            resolution.slots.first { $0.slotID == "arguments" }?.value,
            root.appendingPathComponent("packages/examples/jsonrpc-demo/lib/bin.js").path
        )
        // The composition is named rather than merely counted: it decides what
        // bounds the agent, so the pane has to be able to show which file the
        // walk chose on the operator's behalf.
        XCTAssertEqual(
            resolution.compositionPath,
            root.appendingPathComponent("examples/jsonrpc-agent/cordis.yml").path
        )
    }

    func testSourceCheckoutReportsAnUnbuiltCheckoutRatherThanAMissingEntry() throws {
        // The manifest declares the entrypoint; only the build output is
        // missing. That is the common failure, and it needs its own message —
        // "not found" would send an operator looking for the wrong folder.
        let root = try makeCheckout(entrypointBuilt: false, composition: true)
        let node = try makeExecutable(named: "node")

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertEqual(resolution.slots.map(\.slotID).sorted(), ["cordisConfig", "executable"])
        XCTAssertTrue(
            resolution.problems.contains { $0.contains("build the checkout first") },
            "expected the unbuilt-checkout problem, got \(resolution.problems)"
        )
    }

    func testSourceCheckoutKeepsWhatItCouldDeriveWhenTheCompositionIsAbsent() throws {
        // Partial results are saved on purpose: two filled fields and a named
        // gap beat three empty ones and no explanation.
        let root = try makeCheckout(entrypointBuilt: true, composition: false)
        let node = try makeExecutable(named: "node")

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertEqual(resolution.slots.map(\.slotID).sorted(), ["arguments", "executable"])
        XCTAssertNil(resolution.compositionPath)
        XCTAssertEqual(resolution.problems.count, 1)
    }

    func testSourceCheckoutRefusesAnEntrypointOutsideTheChosenFolder() throws {
        // A manifest is repository content, so a `bin` climbing out of the
        // checkout must not become the argument the backend hands node.
        let root = try makeCheckout(entrypointBuilt: true, composition: true, binPath: "../../../../escape.js")
        let node = try makeExecutable(named: "node")

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertFalse(resolution.slots.contains { $0.slotID == "arguments" })
        XCTAssertTrue(
            resolution.problems.contains { $0.contains("outside the chosen folder") },
            "expected the containment problem, got \(resolution.problems)"
        )
    }

    func testSourceCheckoutRefusesASymlinkedEntrypointOutsideTheChosenFolder() throws {
        let root = try makeCheckout(entrypointBuilt: true, composition: true)
        let node = try makeExecutable(named: "node")
        let entrypoint = root.appendingPathComponent("packages/examples/jsonrpc-demo/lib/bin.js")
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside.js")
        try Data("// outside".utf8).write(to: outside)
        try FileManager.default.removeItem(at: entrypoint)
        try FileManager.default.createSymbolicLink(at: entrypoint, withDestinationURL: outside)

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertFalse(resolution.slots.contains { $0.slotID == "arguments" })
        XCTAssertTrue(
            resolution.problems.contains { $0.contains("outside the chosen folder") },
            "expected the containment problem, got \(resolution.problems)"
        )
    }

    func testSourceCheckoutRefusesASymlinkedCompositionOutsideTheChosenFolder() throws {
        let root = try makeCheckout(entrypointBuilt: true, composition: false)
        let node = try makeExecutable(named: "node")
        let composition = root.appendingPathComponent("examples/jsonrpc-agent/cordis.yml")
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside.yml")
        try FileManager.default.createDirectory(
            at: composition.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("plugins: []".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: composition, withDestinationURL: outside)

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertFalse(resolution.slots.contains { $0.slotID == "cordisConfig" })
        XCTAssertNil(resolution.compositionPath)
        XCTAssertTrue(
            resolution.problems.contains { $0.contains("outside the chosen folder") },
            "expected the containment problem, got \(resolution.problems)"
        )
    }

    func testSourceCheckoutRefusesAnEntrypointPathContainingAComma() throws {
        let root = try makeCheckout(
            entrypointBuilt: true,
            composition: true,
            checkoutName: "deepseek,harness"
        )
        let node = try makeExecutable(named: "node")

        let resolution = RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])

        XCTAssertFalse(resolution.slots.contains { $0.slotID == "arguments" })
        XCTAssertTrue(
            resolution.problems.contains { $0.contains("DEEPSEEK_ARGS cannot represent") },
            "expected the comma-path problem, got \(resolution.problems)"
        )
    }

    /// A checkout with the layout the bundled DeepSeek contract walks.
    private func makeCheckout(
        entrypointBuilt: Bool,
        composition: Bool,
        binPath: String = "lib/bin.js",
        checkoutName: String = "deepseek-harness"
    ) throws -> URL {
        let manager = FileManager.default
        let root = temporaryURL(named: checkoutName)
        let packageDirectory = root.appendingPathComponent("packages/examples/jsonrpc-demo")
        try manager.createDirectory(at: packageDirectory, withIntermediateDirectories: true)
        let manifest = ["name": "@deepseek-ai/dsh-sdk-jsonrpc-demo", "bin": ["dsh-jsonrpc-agent": binPath]] as [String: Any]
        try JSONSerialization.data(withJSONObject: manifest)
            .write(to: packageDirectory.appendingPathComponent("package.json"))
        if entrypointBuilt {
            let built = packageDirectory.appendingPathComponent(binPath)
            try manager.createDirectory(at: built.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("// built".utf8).write(to: built)
        }
        if composition {
            let examples = root.appendingPathComponent("examples/jsonrpc-agent")
            try manager.createDirectory(at: examples, withIntermediateDirectories: true)
            try Data("- id: sdk-jsonrpc-server".utf8).write(to: examples.appendingPathComponent("cordis.yml"))
        }
        return root
    }

    private func makeExecutable(named name: String) throws -> URL {
        let url = temporaryURL(named: name)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    private func temporaryURL(named name: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent(name)
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return url
    }
}
