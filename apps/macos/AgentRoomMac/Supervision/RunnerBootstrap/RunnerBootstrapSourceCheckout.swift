import Foundation

/// How to fill a runner's tier-3 slots from a source checkout the operator
/// points at.
///
/// It exists because of what the alternative asks for. A runner installed from
/// source needs three absolute paths, and two of them live inside a repository
/// layout the operator did not design and has no reason to have memorised. The
/// one thing they do know is where they cloned it, so that is the one thing this
/// asks for; the rest is derived by reading the checkout.
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
    /// Slot receiving the composition.
    var compositionSlotID: String
    /// Candidate compositions relative to the root, in preference order; the
    /// first that exists wins.
    ///
    /// Deliberately a short allowlist rather than "every `*.cordis.yml` under
    /// the checkout". This file decides which tools the agent gets and what
    /// bounds them, so picking one is a trust decision, and a glob would let
    /// repository layout make it. The resolution *names* the file it took for
    /// the same reason: the operator has to be told which one, not merely that
    /// one was found.
    var compositionCandidates: [String]

    /// What a walk of the checkout produced. Partial by design: an entrypoint
    /// that resolved is worth saving even when the composition did not, since
    /// the operator can supply the remainder by hand.
    struct Resolution: Equatable {
        var slots: [ResolvedSlot] = []
        /// The composition actually taken, workspace-relative to the root.
        var compositionPath: String?
        /// What could not be derived, in the operator's terms.
        var problems: [String] = []

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
        var resolution = Resolution()
        let rootURL = root.standardizedFileURL.resolvingSymlinksInPath()

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
        case .found(let url):
            if url.path.contains(",") {
                resolution.problems.append(
                    "The built entrypoint path contains a comma, which DEEPSEEK_ARGS cannot represent. "
                        + "Move or rename the checkout, then choose it again."
                )
            } else {
                resolution.slots.append(.init(slotID: entrypointSlotID, value: url.path))
            }
        case .problem(let problem):
            resolution.problems.append(problem)
        }

        var composition: URL?
        var escapedComposition: String?
        for candidate in compositionCandidates {
            switch checkoutFile(
                at: rootURL.appendingPathComponent(candidate),
                within: rootURL,
                fileManager: fileManager
            ) {
            case .found(let url):
                composition = url
            case .outside:
                escapedComposition = escapedComposition ?? candidate
            case .unavailable:
                break
            }
            if composition != nil {
                break
            }
        }

        if let composition {
            resolution.slots.append(.init(slotID: compositionSlotID, value: composition.path))
            resolution.compositionPath = composition.path
        } else if let escapedComposition {
            resolution.problems.append("Composition \(escapedComposition) resolves outside the chosen folder.")
        } else {
            resolution.problems.append(
                "No composition found at \(compositionCandidates.joined(separator: " or ")). Choose one yourself."
            )
        }

        return resolution
    }

    /// Deliberately not `Result`: the failure side is operator-facing prose,
    /// not an `Error` anything upstack catches or rethrows.
    private enum EntrypointOutcome {
        case found(URL)
        case problem(String)
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
        switch checkoutFile(
            at: packageDirectory.appendingPathComponent(declared),
            within: root,
            fileManager: fileManager
        ) {
        case .found(let url):
            return .found(url)
        case .outside:
            return .problem("\(entrypointBinName) resolves outside the chosen folder.")
        case .unavailable:
            return .problem("\(declared) is declared but missing — build the checkout first.")
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
