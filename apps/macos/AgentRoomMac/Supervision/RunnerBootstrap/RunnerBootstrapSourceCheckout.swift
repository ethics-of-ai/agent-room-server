import Foundation

/// How to fill a runner's tier-3 slots from a source checkout the operator
/// points at.
///
/// It exists because of what the alternative asks for. A runner installed from
/// source needs an interpreter and a built entrypoint, and the entrypoint lives
/// inside a repository layout the operator did not design and has no reason to
/// have memorised. The one thing they do know is where they cloned it, so that
/// is the one thing this asks for; the rest is derived by reading the checkout.
///
/// Bundled like the rest of the bootstrap contract, and for the same reason: it
/// names paths that become an executable and its argument, so a version of this
/// arriving from the backend would be remote code execution by configuration.
/// It only ever *reads* — a package manifest, a file's existence — and executes
/// nothing.
struct RunnerBootstrapSourceCheckout: Equatable {
    /// Slot receiving the interpreter. Found on this machine rather than in the
    /// checkout, because a built JavaScript entrypoint is not itself something
    /// the backend can spawn.
    var interpreterSlotID: String
    var interpreterSearch: ExecutableSearch
    /// Slot receiving the entrypoint, which reaches the child as the
    /// interpreter's one argument.
    var entrypointSlotID: String
    /// Directory, relative to the checkout root, whose `package.json` names the
    /// entrypoint. Read rather than hardcoded: a build that renames its output
    /// still declares the new name here, so the resolution follows the
    /// repository instead of a guess this app shipped months earlier.
    var entrypointPackagePath: String
    /// Which `bin` entry of that manifest serves the protocol.
    var entrypointBinName: String
    /// The package that manifest must be, and the version the backend expects.
    var package: RunnerBootstrapEntrypointPackage
    /// The setup a checkout implies, selected when the operator chooses one.
    var setupChoice: RunnerBootstrapChoiceSelection? = nil
    /// A slot whose readable file means the operator runs a setup of their
    /// own, which choosing a checkout must not replace.
    var customSetupFileSlotID: String? = nil
    /// The caption under the checkout button.
    var note: RunnerBootstrapNote? = nil

    /// What a walk of the checkout produced. Partial by design: an entrypoint
    /// that resolved is worth saving even when no interpreter was found, since
    /// the operator can supply the remainder by hand.
    struct Resolution: Equatable {
        /// The checkout walked, with symlinks resolved, so it compares by path
        /// with the entrypoints the walk derives from it.
        var root: URL
        var slots: [ResolvedSlot] = []
        /// What could not be derived, in the operator's terms.
        var problems: [String] = []
        /// Remarks that block nothing.
        var notices: [String] = []
        /// The checkout's package version, when its manifest names one.
        var version: String?
        /// The fix that would make the checkout launchable, when one is known.
        var repair: RunnerBootstrapCheckoutRepair?

        struct ResolvedSlot: Equatable {
            var slotID: String
            var value: String
        }
    }

    func resolve(
        root: URL,
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Resolution {
        let rootURL = root.standardizedFileURL.resolvingSymlinksInPath()
        var resolution = Resolution(root: rootURL)

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: rootURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            resolution.problems.append("\(rootURL.path) is not a folder.")
            return resolution
        }

        let locator = ExecutablePathLocator(
            search: interpreterSearch,
            environment: environment,
            fileManager: fileManager
        )
        if let interpreter = locator.locateExecutable() {
            resolution.slots.append(.init(slotID: interpreterSlotID, value: interpreter.path))
        } else {
            resolution.problems.append("No \(interpreterSearch.binaryName) interpreter was found on this Mac.")
        }

        switch entrypoint(in: rootURL, fileManager: fileManager) {
        case .found(let url, let manifest):
            let assessment = package.assess(manifest: manifest.contents, manifestURL: manifest.url, entrypoint: url)
            record(assessment, version: manifest.contents["version"] as? String, in: &resolution)
            if case .otherPackage = assessment {
                break
            } else if url.path.contains(",") {
                resolution.problems.append(
                    "The built entrypoint path contains a comma, which a comma-separated argument list "
                        + "cannot hold. Move or rename the checkout, then choose it again."
                )
            } else {
                resolution.slots.append(.init(slotID: entrypointSlotID, value: url.path))
            }
        case .unbuilt(let declared, let manifest):
            let assessment = package.assess(manifest: manifest.contents, manifestURL: manifest.url, entrypoint: nil)
            switch assessment {
            case .outdated, .otherPackage:
                // Updating builds too, so the older version is the one to
                // report, and no build turns another package into this one.
                record(assessment, version: manifest.contents["version"] as? String, in: &resolution)
            case .tested, .untested, .unverified, .builtBeforeUpdate:
                resolution.problems.append("\(declared) is declared but missing — build the checkout first.")
                resolution.version = manifest.contents["version"] as? String
                resolution.repair = .build
            }
        case .problem(let problem):
            resolution.problems.append(problem)
        }

        return resolution
    }

    private func record(
        _ assessment: RunnerBootstrapEntrypointPackage.Assessment,
        version: String?,
        in resolution: inout Resolution
    ) {
        let verdict = package.verdict(for: assessment)
        resolution.problems += [verdict.problem].compactMap { $0 }
        resolution.notices += [verdict.notice].compactMap { $0 }
        resolution.repair = verdict.repair
        if case .otherPackage = assessment { return }
        resolution.version = version
    }

    /// The checkout an entrypoint was built in, read from its path alone:
    /// `<root>/apps/cli/lib/bin.js` gives `<root>`. Lets the pane recheck the
    /// checkout behind a saved entrypoint without asking for the folder again.
    func checkoutRoot(containing entrypoint: String) -> URL? {
        guard NSString(string: entrypoint).isAbsolutePath else { return nil }
        let components = URL(fileURLWithPath: entrypoint).standardizedFileURL.pathComponents
        let packageComponents = entrypointPackagePath.split(separator: "/").map(String.init)
        guard !packageComponents.isEmpty, components.count > packageComponents.count + 1 else { return nil }
        for start in stride(from: components.count - packageComponents.count - 1, through: 1, by: -1)
        where Array(components[start..<start + packageComponents.count]) == packageComponents {
            return URL(fileURLWithPath: NSString.path(withComponents: Array(components[..<start])), isDirectory: true)
        }
        return nil
    }

    /// The setup choice to store along with the derived paths, or `nil` when
    /// the stored one should stay: it is already selected, or the operator
    /// keeps a readable file of their own for the other setup.
    func setupChoiceToApply(
        storedValue: (String) -> String?,
        fileManager: FileManager = .default
    ) -> RunnerBootstrapChoiceSelection? {
        guard let setupChoice, !setupChoice.isSelected(storedValue: storedValue) else { return nil }
        if let slotID = customSetupFileSlotID,
           let path = storedValue(slotID)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty,
           fileManager.isReadableFile(atPath: NSString(string: path).expandingTildeInPath) {
            return nil
        }
        return setupChoice
    }

    /// What the pane shows for a walk. `filledTitles` names the fields the
    /// walk saved, and is empty when the walk only rechecked a known checkout.
    func outcome(
        for resolution: Resolution,
        filledTitles: [String],
        setupTitle: String?
    ) -> RunnerBootstrapSourceCheckoutOutcome {
        let root = resolution.root
        guard !resolution.slots.isEmpty else {
            return RunnerBootstrapSourceCheckoutOutcome(
                status: .failed(message: ""),
                message: (["Nothing could be filled from \(root.path)."] + resolution.problems).joined(separator: " "),
                root: root,
                repair: resolution.repair
            )
        }
        let name = root.lastPathComponent
        let blocked = resolution.repair != nil || !resolution.problems.isEmpty
        var parts: [String] = []
        // With a repair to offer, the problem leads and nothing restates it:
        // the filled fields are visible below, and the version is in the problem.
        // A notice names the version too, so it is not stated beside one either.
        if resolution.repair == nil {
            let named = blocked || !resolution.notices.isEmpty
            let version = named ? "" : resolution.version.map { ", which has \(package.displayName) \($0)" } ?? ""
            parts.append(filledTitles.isEmpty
                ? "Checked \(name)\(version)."
                : "Filled \(ListFormatter.localizedString(byJoining: filledTitles)) from \(name)\(version).")
        }
        parts += resolution.problems
        if let setupTitle {
            parts.append("Setup is now \(setupTitle).")
        }
        parts += resolution.notices
        if let repair = resolution.repair {
            parts.append(repair.instruction)
        } else if !filledTitles.isEmpty {
            parts.append("Restart the backend to apply.")
        }
        let status: RunnerBootstrapCheckStatus = if blocked {
            .failed(message: "")
        } else if filledTitles.isEmpty {
            .satisfied(detail: root.path)
        } else {
            .detected(detail: root.path)
        }
        return RunnerBootstrapSourceCheckoutOutcome(
            status: status,
            message: parts.joined(separator: " "),
            root: root,
            repair: resolution.repair
        )
    }

    /// Whether `outcome` already offers the fix for the checkout an entrypoint
    /// belongs to, so a row checking that entrypoint need not report the same
    /// problem a second time.
    ///
    /// Compares paths only and touches no file, because the pane asks while
    /// drawing. The walk resolves symlinks in the root and in every entrypoint
    /// it saves, so the two sides agree for any entrypoint it filled in. A
    /// path typed by hand through a symlink fails the comparison, and its row
    /// then reports the problem itself.
    func offersRepair(_ outcome: RunnerBootstrapSourceCheckoutOutcome?, forEntrypointIn arguments: String?) -> Bool {
        guard let outcome, outcome.repair != nil,
              let root = RunnerBootstrapArgumentList.first(in: arguments).flatMap(checkoutRoot(containing:))
        else { return false }
        return root.path == outcome.root.path
    }

    /// Deliberately not `Result`: the failure side is operator-facing prose,
    /// not an `Error` anything upstack catches or rethrows.
    private enum EntrypointOutcome {
        case found(URL, Manifest)
        /// Declared by the manifest but not on disk: the checkout is unbuilt.
        case unbuilt(declared: String, Manifest)
        case problem(String)
    }

    private struct Manifest {
        var url: URL
        var contents: [String: Any]
    }

    private enum CheckoutFileOutcome {
        case found(URL)
        case outside
        case unavailable
    }

    /// The built entrypoint, via the package manifest that declares it.
    ///
    /// Every step is checked rather than assumed, because each failure means
    /// something different to the operator: a missing package directory is the
    /// wrong folder, a missing `bin` entry is an upstream layout this build does
    /// not know, and a declared-but-absent file is an unbuilt checkout — which
    /// is the common one, and the one a "not found" alone would leave them
    /// guessing about.
    private func entrypoint(in root: URL, fileManager: FileManager) -> EntrypointOutcome {
        let packageDirectory = root.appendingPathComponent(entrypointPackagePath).standardizedFileURL
        let manifestURL = packageDirectory.appendingPathComponent("package.json")
        let resolvedManifest: URL
        switch checkoutFile(at: manifestURL, within: root, fileManager: fileManager) {
        case .found(let url):
            resolvedManifest = url
        case .outside:
            return .problem("\(entrypointPackagePath)/package.json resolves outside the chosen folder.")
        case .unavailable:
            return .problem("No package manifest at \(entrypointPackagePath)/package.json — is this the right folder?")
        }
        guard let data = fileManager.contents(atPath: resolvedManifest.path) else {
            return .problem("No package manifest at \(entrypointPackagePath)/package.json — is this the right folder?")
        }
        guard
            let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let declared = binPath(in: manifest)
        else {
            return .problem("\(entrypointPackagePath)/package.json declares no \(entrypointBinName) entry.")
        }
        let parsed = Manifest(url: resolvedManifest, contents: manifest)
        switch checkoutFile(
            at: packageDirectory.appendingPathComponent(declared),
            within: root,
            fileManager: fileManager
        ) {
        case .found(let url):
            return .found(url, parsed)
        case .outside:
            return .problem("\(entrypointBinName) resolves outside the chosen folder.")
        case .unavailable:
            return .unbuilt(declared: declared, parsed)
        }
    }

    /// Resolve symlinks before testing containment. A repository-controlled
    /// symlink may point at another regular file in the checkout, but never at
    /// a file outside the folder the operator selected.
    private func checkoutFile(
        at candidate: URL,
        within root: URL,
        fileManager: FileManager
    ) -> CheckoutFileOutcome {
        let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard isDescendant(resolved, of: root) else {
            return .outside
        }
        guard
            let values = try? resolved.resourceValues(forKeys: [.isRegularFileKey]),
            values.isRegularFile == true,
            fileManager.isReadableFile(atPath: resolved.path)
        else {
            return .unavailable
        }
        return .found(resolved)
    }

    private func isDescendant(_ candidate: URL, of root: URL) -> Bool {
        let rootComponents = root.pathComponents
        let candidateComponents = candidate.pathComponents
        return candidateComponents.count > rootComponents.count
            && candidateComponents.starts(with: rootComponents)
    }

    /// npm allows `bin` as a map of names to paths, or as a single string that
    /// names the package's own executable.
    ///
    /// The string form is accepted only when the package is itself the wanted
    /// one, so a package whose sole executable happens to be something else is
    /// not silently taken for it.
    private func binPath(in manifest: [String: Any]) -> String? {
        if let bins = manifest["bin"] as? [String: String] {
            return bins[entrypointBinName]
        }
        guard
            let single = manifest["bin"] as? String,
            let name = manifest["name"] as? String,
            name == entrypointBinName || name.hasSuffix("/\(entrypointBinName)")
        else {
            return nil
        }
        return single
    }
}
