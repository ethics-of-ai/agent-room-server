import Foundation

/// The npm package a runner's built entrypoint must come from, and the version
/// the backend was tested against.
///
/// A readable file is not enough to launch DeepSeek. An old checkout still has
/// an `apps/cli/lib/bin.js`, and a configuration saved before Harness 86a40220
/// points at an entrypoint upstream has since deleted, and both pass a plain
/// file check. Each fails only once the backend spawns the child. The package
/// manifest next to the entrypoint answers this without running anything, and
/// it is the same `package.json` the source-checkout walk already reads.
///
/// Bundled with the descriptor. Bump `testedVersion` and `testedRevision`
/// with the backend's Harness pin in `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`.
struct RunnerBootstrapEntrypointPackage: Equatable {
    /// The manifest `name`, such as `@deepseek-ai/dsh`.
    var name: String
    /// What the operator calls it, such as `dsh`.
    var displayName: String
    var testedVersion: String
    /// The upstream commit carrying `testedVersion`, which the update script
    /// checks out.
    var testedRevision: String

    enum Assessment: Equatable {
        /// The tested version, built after its sources last changed.
        case tested
        /// A newer or unparseable version. Allowed, with a notice.
        case untested(version: String)
        /// No manifest or no version to compare. Nothing to report.
        case unverified
        case outdated(version: String)
        /// The build output predates the package manifest, as a pull that
        /// moved the version without a rebuild leaves it. Source edits that
        /// leave the manifest alone do not show here.
        case builtBeforeUpdate(version: String?)
        case otherPackage(name: String)
    }

    /// Judge a manifest, and the entrypoint it declares when that was built.
    func assess(manifest: [String: Any], manifestURL: URL, entrypoint: URL?) -> Assessment {
        guard let manifestName = manifest["name"] as? String else { return .unverified }
        guard manifestName == name else { return .otherPackage(name: manifestName) }
        let version = manifest["version"] as? String
        if let version,
           let found = SemanticVersion(rawValue: version),
           let tested = SemanticVersion(rawValue: testedVersion),
           found < tested {
            return .outdated(version: version)
        }
        if let entrypoint, Self.modificationDate(of: entrypoint) < Self.modificationDate(of: manifestURL) {
            return .builtBeforeUpdate(version: version)
        }
        guard let version else { return .unverified }
        return version == testedVersion ? .tested : .untested(version: version)
    }

    /// Judge an entrypoint on its own, through the nearest manifest above it.
    /// Used where no checkout root is known, such as a path typed by hand or
    /// an npm install under `node_modules`.
    func assess(entrypoint: URL, fileManager: FileManager = .default) -> Assessment {
        var directory = entrypoint.deletingLastPathComponent()
        // `lib/bin.js` sits one level below its manifest. Three levels allow
        // for a deeper build layout without walking far out of the package.
        for _ in 0..<3 {
            let manifestURL = directory.appendingPathComponent("package.json")
            if let data = fileManager.contents(atPath: manifestURL.path) {
                guard let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    return .unverified
                }
                return assess(manifest: manifest, manifestURL: manifestURL, entrypoint: entrypoint)
            }
            directory = directory.deletingLastPathComponent()
        }
        return .unverified
    }

    /// What an assessment means to the operator.
    struct Verdict: Equatable {
        /// What blocks a launch, in the operator's terms.
        var problem: String? = nil
        /// A remark that blocks nothing.
        var notice: String? = nil
        /// The fix, when the entrypoint sits in a checkout that can take one.
        var repair: RunnerBootstrapCheckoutRepair? = nil
    }

    func verdict(for assessment: Assessment) -> Verdict {
        switch assessment {
        case .tested, .unverified:
            Verdict()
        case .untested(let version):
            Verdict(notice: "\(displayName) \(version) is not the \(testedVersion) AgentRoom was tested with, so it may not start.")
        case .outdated(let version):
            Verdict(
                problem: "This checkout has \(displayName) \(version). AgentRoom needs \(displayName) \(testedVersion).",
                repair: .update(revision: testedRevision)
            )
        case .builtBeforeUpdate:
            Verdict(
                problem: "The \(displayName) build is older than its package manifest. Build the checkout again.",
                repair: .build
            )
        case .otherPackage(let other):
            Verdict(problem: "This entrypoint belongs to \(other), not \(name).")
        }
    }

    private static func modificationDate(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }
}
