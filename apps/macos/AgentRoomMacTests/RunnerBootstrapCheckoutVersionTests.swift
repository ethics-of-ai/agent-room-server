import XCTest
@testable import AgentRoomMac

/// The DeepSeek checkout and entrypoint checks that catch a launcher the
/// backend cannot run before the backend tries to spawn it: an old checkout,
/// a build older than its manifest, and an entrypoint from another package.
final class RunnerBootstrapCheckoutVersionTests: XCTestCase {
    private let pinned = "86a402200d95fecef4529d969836f1fe13c6cb0d"

    // MARK: - Checkout walk

    func testTestedCheckoutNeedsNoRepair() throws {
        let root = try makeCheckout(version: "0.2.1-alpha.4")

        let resolution = try walk(root)

        XCTAssertEqual(resolution.problems, [])
        XCTAssertNil(resolution.repair)
        XCTAssertEqual(resolution.version, "0.2.1-alpha.4")
        let outcome = contract().outcome(
            for: resolution,
            filledTitles: ["Executable", "Arguments"],
            setupTitle: "AgentRoom managed"
        )
        XCTAssertEqual(outcome.status, .detected(detail: root.resolvingSymlinksInPath().path))
        XCTAssertEqual(
            outcome.message,
            "Filled Executable and Arguments from deepseek-harness, which has dsh 0.2.1-alpha.4. "
                + "Setup is now AgentRoom managed. Restart the backend to apply."
        )
    }

    func testOutdatedCheckoutOffersAnUpdateToThePinnedRevision() throws {
        // The checkout this was found on: 0.1.0-rc.7 already has an
        // `apps/cli/lib/bin.js`, so a file check alone passed it.
        let root = try makeCheckout(version: "0.1.0-rc.7")

        let resolution = try walk(root)

        XCTAssertEqual(resolution.repair, .update(revision: pinned))
        XCTAssertEqual(resolution.problems, ["This checkout has dsh 0.1.0-rc.7. AgentRoom needs dsh 0.2.1-alpha.4."])
        // The paths are right once the checkout is updated, so they are kept.
        XCTAssertTrue(resolution.slots.contains { $0.slotID == "arguments" })
        let outcome = contract().outcome(
            for: resolution,
            filledTitles: ["Executable", "Arguments"],
            setupTitle: "AgentRoom managed"
        )
        XCTAssertEqual(outcome.status, .failed(message: ""))
        // The version is stated once, and the fix closes the message.
        XCTAssertEqual(
            outcome.message,
            "This checkout has dsh 0.1.0-rc.7. AgentRoom needs dsh 0.2.1-alpha.4. "
                + "Setup is now AgentRoom managed. Update it in Terminal, then check again."
        )
    }

    func testCheckoutRowSpeaksForTheEntrypointOfTheCheckoutItRepairs() throws {
        let root = try makeCheckout(version: "0.1.0-rc.7")
        let outcome = contract().outcome(for: try walk(root), filledTitles: [], setupTitle: nil)
        let entrypoint = root.resolvingSymlinksInPath().appendingPathComponent("apps/cli/lib/bin.js").path

        XCTAssertTrue(contract().offersRepair(outcome, forEntrypointIn: entrypoint))
        // Another checkout's entrypoint, or one outside any checkout, keeps
        // its own failure, since this row offers nothing for it.
        XCTAssertFalse(contract().offersRepair(outcome, forEntrypointIn: "/elsewhere/deepseek-harness/apps/cli/lib/bin.js"))
        XCTAssertFalse(contract().offersRepair(outcome, forEntrypointIn: "/x/packages/examples/jsonrpc-demo/lib/bin.js"))
        var repaired = outcome
        repaired.repair = nil
        XCTAssertFalse(contract().offersRepair(repaired, forEntrypointIn: entrypoint))
    }

    func testEntrypointCheckSitsOnTheArgumentsRow() throws {
        let probe = try XCTUnwrap(RunnerBootstrapTestSupport.descriptor("deepseek").probe("entrypoint"))

        XCTAssertEqual(probe.displaySlotID, "arguments")
        XCTAssertNil(probe.resolvedSlotID)
    }

    func testUnbuiltOutdatedCheckoutOffersTheUpdateRatherThanABuild() throws {
        let root = try makeCheckout(version: "0.1.0-rc.7", built: false)

        XCTAssertEqual(try walk(root).repair, .update(revision: pinned))
    }

    func testUnbuiltCheckoutOffersABuild() throws {
        let root = try makeCheckout(version: "0.2.1-alpha.4", built: false)

        let resolution = try walk(root)

        XCTAssertEqual(resolution.repair, .build)
        XCTAssertTrue(resolution.problems.contains { $0.contains("build the checkout first") }, "\(resolution.problems)")
    }

    func testCheckoutBuiltBeforeItsManifestChangedOffersABuild() throws {
        let root = try makeCheckout(version: "0.2.1-alpha.4", builtBeforeManifest: true)

        let resolution = try walk(root)

        XCTAssertEqual(resolution.repair, .build)
        XCTAssertEqual(resolution.problems, ["The dsh build is older than its package manifest. Build the checkout again."])
    }

    func testNewerCheckoutIsAllowedWithANotice() throws {
        let root = try makeCheckout(version: "0.3.0")

        let resolution = try walk(root)

        XCTAssertNil(resolution.repair)
        XCTAssertEqual(resolution.problems, [])
        XCTAssertEqual(resolution.notices.count, 1)
        let outcome = contract().outcome(for: resolution, filledTitles: ["Arguments"], setupTitle: nil)
        XCTAssertEqual(outcome.status, .detected(detail: root.resolvingSymlinksInPath().path))
        // The notice names the version, so the filled line does not.
        XCTAssertEqual(outcome.message.components(separatedBy: "0.3.0").count, 2, outcome.message)
    }

    func testUnbuiltCheckoutOfAnotherPackageIsNotOfferedABuild() throws {
        // Building would not turn it into the launcher, so the wrong package
        // is the problem to report.
        let root = temporaryDirectory().appendingPathComponent("deepseek-harness")
        try RunnerBootstrapTestSupport.makePackage(
            at: root.appendingPathComponent("apps/cli"),
            name: "@example/fork-cli",
            version: "0.2.1-alpha.4",
            built: false
        )

        let resolution = try walk(root)

        XCTAssertNil(resolution.repair)
        XCTAssertEqual(resolution.problems, ["This entrypoint belongs to @example/fork-cli, not @deepseek-ai/dsh."])
    }

    func testCheckoutWhosePackageIsNotTheLauncherFillsNoEntrypoint() throws {
        let root = temporaryDirectory().appendingPathComponent("deepseek-harness")
        try RunnerBootstrapTestSupport.makePackage(
            at: root.appendingPathComponent("apps/cli"),
            name: "@deepseek-ai/dsh-sdk-jsonrpc-demo",
            version: "0.1.0-rc.7"
        )

        let resolution = try walk(root)

        XCTAssertFalse(resolution.slots.contains { $0.slotID == "arguments" })
        XCTAssertNil(resolution.repair)
    }

    // MARK: - Entrypoint probe

    func testEntrypointProbeRejectsTheRemovedJsonRpcDemo() throws {
        // A configuration saved before Harness 86a40220 pointed here, and the
        // file is still readable in a checkout that was never updated.
        let demo = temporaryDirectory().appendingPathComponent("packages/examples/jsonrpc-demo")
        try RunnerBootstrapTestSupport.makePackage(
            at: demo,
            name: "@deepseek-ai/dsh-sdk-jsonrpc-demo",
            version: "0.1.0-rc.7"
        )

        let status = runEntrypointProbe(demo.appendingPathComponent("lib/bin.js"))

        guard case .failed(let message) = status else { return XCTFail("expected a failure, got \(status)") }
        XCTAssertTrue(message.contains("@deepseek-ai/dsh-sdk-jsonrpc-demo"), message)
    }

    func testEntrypointProbeRejectsAnOutdatedLauncher() throws {
        let cli = temporaryDirectory().appendingPathComponent("apps/cli")
        try RunnerBootstrapTestSupport.makePackage(at: cli, version: "0.1.0-rc.7")

        let status = runEntrypointProbe(cli.appendingPathComponent("lib/bin.js"))

        guard case .failed(let message) = status else { return XCTFail("expected a failure, got \(status)") }
        XCTAssertTrue(message.hasPrefix("This checkout has dsh 0.1.0-rc.7."), message)
    }

    func testEntrypointProbeAcceptsAnNpmInstallOfTheTestedLauncher() throws {
        let package = temporaryDirectory().appendingPathComponent("node_modules/@deepseek-ai/dsh")
        try RunnerBootstrapTestSupport.makePackage(at: package, version: "0.2.1-alpha.4")
        let entrypoint = package.appendingPathComponent("lib/bin.js")

        XCTAssertEqual(runEntrypointProbe(entrypoint), .satisfied(detail: entrypoint.path))
    }

    // MARK: - Checkout root and setup choice

    func testCheckoutRootIsReadFromTheEntrypointPath() {
        XCTAssertEqual(
            contract().checkoutRoot(containing: "/Users/x/repos/deepseek-harness/apps/cli/lib/bin.js")?.path,
            "/Users/x/repos/deepseek-harness"
        )
        XCTAssertNil(contract().checkoutRoot(containing: "/Users/x/deepseek-harness/packages/examples/jsonrpc-demo/lib/bin.js"))
        XCTAssertNil(contract().checkoutRoot(containing: "apps/cli/lib/bin.js"))
    }

    func testChoosingACheckoutSelectsManagedSetupUnlessACustomCompositionIsKept() throws {
        let composition = temporaryDirectory().appendingPathComponent("graph.patch.yml")
        try RunnerBootstrapTestSupport.write("- insert: []", to: composition)
        let managed = RunnerBootstrapChoiceSelection(slotID: "compositionMode", choiceID: "managed")
        func choice(mode: String?, file: String?) -> RunnerBootstrapChoiceSelection? {
            contract().setupChoiceToApply { slotID in
                slotID == "compositionMode" ? mode : slotID == "cordisConfig" ? file : nil
            }
        }

        XCTAssertEqual(choice(mode: nil, file: nil), managed)
        XCTAssertEqual(choice(mode: "custom", file: "/no/such/file.yml"), managed)
        XCTAssertNil(choice(mode: "managed", file: nil))
        XCTAssertNil(choice(mode: "custom", file: composition.path))
        XCTAssertNil(choice(mode: nil, file: composition.path))
    }

    // MARK: - Repair script

    func testUpdateScriptChecksOutThePinAfterRefusingLocalChanges() throws {
        let root = URL(fileURLWithPath: "/Users/x/it's here/deepseek-harness")

        let script = RunnerBootstrapCheckoutRepair.update(revision: pinned).script(root: root)

        XCTAssertTrue(script.contains("cd -- '/Users/x/it'\\''s here/deepseek-harness'"), script)
        let repositoryIndex = try XCTUnwrap(script.range(of: "git rev-parse --is-inside-work-tree"))
        let guardIndex = try XCTUnwrap(script.range(of: "git status --porcelain --untracked-files=no"))
        let presentIndex = try XCTUnwrap(script.range(of: "if ! git cat-file -e '\(pinned)^{commit}'"))
        let fetchIndex = try XCTUnwrap(script.range(of: "run git fetch origin"))
        let checkoutIndex = try XCTUnwrap(script.range(of: "run git checkout --detach '\(pinned)'"))
        XCTAssertLessThan(repositoryIndex.lowerBound, guardIndex.lowerBound)
        XCTAssertLessThan(guardIndex.lowerBound, presentIndex.lowerBound)
        // A checkout that already has the pin needs no remote, so the fetch
        // runs only when the commit is missing.
        XCTAssertLessThan(presentIndex.lowerBound, fetchIndex.lowerBound)
        XCTAssertLessThan(fetchIndex.lowerBound, checkoutIndex.lowerBound)
        XCTAssertTrue(script.contains("run pnpm install --frozen-lockfile\nrun pnpm run build"), script)
    }

    func testBuildScriptLeavesTheCheckedOutRevisionAlone() {
        let script = RunnerBootstrapCheckoutRepair.build.script(root: URL(fileURLWithPath: "/tmp/deepseek-harness"))

        XCTAssertFalse(script.contains("git "), script)
        XCTAssertTrue(script.contains("run pnpm run build"), script)
    }

    // MARK: - Helpers

    private func contract() -> RunnerBootstrapSourceCheckout {
        RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [])
    }

    private func walk(_ root: URL) throws -> RunnerBootstrapSourceCheckout.Resolution {
        let node = temporaryDirectory().appendingPathComponent("node")
        try RunnerBootstrapTestSupport.makeExecutableFile(at: node)
        return RunnerBootstrapTestSupport.sourceCheckout(interpreterCandidates: [node])
            .resolve(root: root, environment: [:])
    }

    private func runEntrypointProbe(_ entrypoint: URL) -> RunnerBootstrapCheckStatus {
        let descriptor = RunnerBootstrapTestSupport.descriptor("deepseek")
        guard let probe = descriptor.probe("entrypoint") else {
            XCTFail("the bundled DeepSeek descriptor is expected to check its entrypoint")
            return .absent
        }
        return RunnerBootstrapTestSupport.prober().run(probe, of: descriptor) { slotID in
            slotID == "executable" ? "/usr/bin/node" : entrypoint.path
        }.status
    }

    private func makeCheckout(
        version: String?,
        built: Bool = true,
        builtBeforeManifest: Bool = false
    ) throws -> URL {
        let root = temporaryDirectory().appendingPathComponent("deepseek-harness")
        try RunnerBootstrapTestSupport.makePackage(
            at: root.appendingPathComponent("apps/cli"),
            version: version,
            built: built,
            builtBeforeManifest: builtBeforeManifest
        )
        return root
    }

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
